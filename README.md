# rs-migrate

Versioned document migrations for [remoteStorage](https://remotestorage.io/) apps. Zero dependencies.

Each document tracks its own version. Old documents — whether from a cold cache, a stale sync, or localStorage — get migrated automatically when you read them. New migrations are just functions: register them once, and every document flows through the right transforms in order.

## Install

```
npm install rs-migrate
```

## Quick start

```js
import { createMigrator } from 'rs-migrate';

const migrator = createMigrator();

migrator.register({
  version: 1,
  collection: 'songs',
  description: 'Add default tempo',
  transform(doc) {
    doc.tempo = doc.tempo ?? 120;
    return doc;
  },
});

migrator.register({
  version: 2,
  collection: 'songs',
  description: 'Rename bpm to tempo',
  transform(doc) {
    if (doc.bpm) {
      doc.tempo = doc.bpm;
      delete doc.bpm;
    }
    return doc;
  },
});

// Migrate a single document (lazy, on read)
const song = migrator.migrateDocument('songs', rawSong);
// song._migrateVersion === 2
```

## How it works

1. You register migrations — each has a `version` number, a `collection` name, and a `transform` function.
2. When you call `migrateDocument`, the migrator checks `doc[versionField]` (default `"_migrateVersion"`). If it's behind, the document is deep-cloned, run through each pending transform in version order, and stamped with the new version.
3. Documents already at the latest version are returned as-is (same reference, no clone).

Transforms can safely mutate — they always receive a deep clone of the original.

## API

### `createMigrator(options?)`

Returns a new `Migrator` instance.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `versionField` | `string` | `"_migrateVersion"` | The property name used to track document version |

```js
// Use an existing version field
const migrator = createMigrator({ versionField: 'schemaVersion' });
```

---

### `migrator.register(migration)`

Register a single migration. Throws if the version is already registered for that collection.

```js
migrator.register({
  version: 1,
  collection: 'songs',
  description: 'Normalize key format',
  transform(doc) {
    doc.key = doc.key?.toUpperCase() ?? 'C';
    return doc;
  },
});
```

**Migration descriptor fields:**

| Field | Type | Description |
|-------|------|-------------|
| `version` | `number` | Positive integer. The version this migration produces. |
| `collection` | `string` | Scoping label (e.g. `"songs"`, `"config"`) |
| `description` | `string` | Human-readable, for logging or debugging |
| `transform` | `(doc) => doc` | Receives a deep clone, returns the transformed document |

---

### `migrator.registerAll(migrations)`

Register multiple migrations at once. Same rules as `register` — duplicates throw.

```js
migrator.registerAll([
  { version: 1, collection: 'songs', description: '...', transform: (d) => d },
  { version: 2, collection: 'songs', description: '...', transform: (d) => d },
]);
```

---

### `migrator.migrateDocument(collection, doc)`

Run pending migrations on a single document. Returns the original reference if already current.

```js
const song = migrator.migrateDocument('songs', rawSong);
```

- Documents without a version field are treated as version 0.
- The document is deep-cloned before any transforms run.
- The version field is stamped after all transforms complete.

---

### `migrator.migrateAll(collection, adapter)`

Eagerly migrate all documents in a collection. Calls `save` only for documents that actually changed.

```js
const results = await migrator.migrateAll('songs', {
  getAll: () => client.getAll('songs/', false),
  save: (key, doc) => client.storeObject('song', `songs/${key}`, doc),
});

console.log(`Migrated ${results.length} documents`);
```

**Adapter:**

| Method | Signature | Description |
|--------|-----------|-------------|
| `getAll` | `() => Promise<Record<string, any>>` | Return all documents keyed by ID |
| `save` | `(key, doc) => Promise<void>` | Persist a migrated document |

**Returns** `MigrateResult[]`:

| Field | Type | Description |
|-------|------|-------------|
| `key` | `string` | Document key from `getAll` |
| `doc` | `any` | The migrated document |
| `fromVersion` | `number` | Version before migration |
| `toVersion` | `number` | Version after migration |
| `migrationsApplied` | `number` | Number of transforms that ran |

---

### `migrator.migrateLocalStorage(collection, key, opts?)`

Read a JSON value from `localStorage`, migrate it, and write it back.

```js
// Single object
migrator.migrateLocalStorage('config', 'app-config');

// Array of documents
migrator.migrateLocalStorage('savedSetlists', 'saved-sets', { isArray: true });
```

No-ops if the key doesn't exist in localStorage.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `isArray` | `boolean` | `false` | Treat the stored value as an array of documents |

---

### `migrator.getPending(collection, docs)`

Check which migrations are outstanding for a set of documents.

```js
const pending = migrator.getPending('songs', allSongs);
for (const info of pending) {
  if (info.pendingMigrations.length > 0) {
    console.log(`Doc at v${info.currentVersion} needs ${info.pendingMigrations.length} migrations`);
  }
}
```

**Returns** `PendingInfo[]`:

| Field | Type | Description |
|-------|------|-------------|
| `doc` | `any` | The original document |
| `currentVersion` | `number` | Current version of the document |
| `pendingMigrations` | `MigrationDescriptor[]` | Migrations that still need to run |

---

### `migrator.getLatestVersion(collection)`

Returns the highest registered version for a collection, or `0` if none are registered.

```js
migrator.getLatestVersion('songs'); // 2
migrator.getLatestVersion('unknown'); // 0
```

## Real-world example

A remoteStorage app with songs and config collections, plus saved setlists in localStorage:

```js
import { createMigrator } from 'rs-migrate';

export const migrator = createMigrator({ versionField: 'schemaVersion' });

// --- songs ---
migrator.register({
  version: 2,
  collection: 'songs',
  description: 'Convert picking from boolean to array',
  transform(doc) {
    for (const member of Object.values(doc.members || {})) {
      for (const inst of member.instruments || []) {
        if (!Array.isArray(inst.picking)) inst.picking = [];
      }
    }
    return doc;
  },
});

// --- config ---
migrator.register({
  version: 2,
  collection: 'config',
  description: 'Strip deprecated energy fields',
  transform(doc) {
    const w = doc.general?.weighting;
    if (w) {
      delete w.energyTarget;
      delete w.repeatEnergy;
    }
    return doc;
  },
});

// --- savedSetlists (localStorage) ---
migrator.register({
  version: 1,
  collection: 'savedSetlists',
  description: 'Remove energy from saved setlists',
  transform(doc) {
    doc.songs = (doc.songs || []).map(({ energy, ...rest }) => rest);
    return doc;
  },
});
```

Then in your app's data layer:

```js
// Lazy: migrate on read
function loadSong(raw) {
  return migrator.migrateDocument('songs', raw);
}

// Eager: migrate everything after sync
await migrator.migrateAll('songs', {
  getAll: () => client.getAll('songs/', false),
  save: (key, doc) => client.storeObject('song', `songs/${key}`, doc),
});

// localStorage
migrator.migrateLocalStorage('savedSetlists', 'saved-sets', { isArray: true });
```

## License

GPL-3.0
