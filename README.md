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
  collection: 'contacts',
  description: 'Split full name into first/last',
  transform(doc) {
    if (doc.name && !doc.firstName) {
      const [first, ...rest] = doc.name.split(' ');
      doc.firstName = first;
      doc.lastName = rest.join(' ');
      delete doc.name;
    }
    return doc;
  },
});

migrator.register({
  version: 2,
  collection: 'contacts',
  description: 'Add default country',
  transform(doc) {
    doc.country = doc.country ?? 'US';
    return doc;
  },
});

// Migrate a single document (lazy, on read)
const contact = migrator.migrateDocument('contacts', rawContact);
// contact._migrateVersion === 2
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
  collection: 'contacts',
  description: 'Add email array',
  transform(doc) {
    if (doc.email && !doc.emails) {
      doc.emails = [doc.email];
      delete doc.email;
    }
    return doc;
  },
});
```

**Migration descriptor fields:**

| Field | Type | Description |
|-------|------|-------------|
| `version` | `number` | Positive integer. The version this migration produces. |
| `collection` | `string` | Scoping label (e.g. `"contacts"`, `"settings"`) |
| `description` | `string` | Human-readable, for logging or debugging |
| `transform` | `(doc) => doc` | Receives a deep clone, returns the transformed document |

---

### `migrator.registerAll(migrations)`

Register multiple migrations at once. The operation is atomic — if any migration in the batch is invalid (duplicate version, non-positive integer), none are registered. Same validation rules as `register`.

```js
migrator.registerAll([
  { version: 1, collection: 'contacts', description: '...', transform: (d) => d },
  { version: 2, collection: 'contacts', description: '...', transform: (d) => d },
]);
```

---

### `migrator.migrateDocument(collection, doc)`

Run pending migrations on a single document. Returns the original reference if already current.

```js
const contact = migrator.migrateDocument('contacts', rawContact);
```

- Documents without a version field are treated as version 0.
- The document is deep-cloned before any transforms run.
- The version field is stamped after all transforms complete.

---

### `migrator.migrateAll(collection, adapter)`

Eagerly migrate all documents in a collection. Calls `save` only for documents that actually changed.

```js
const results = await migrator.migrateAll('contacts', {
  getAll: () => client.getAll('contacts/'),
  save: (key, doc) => client.storeObject('contact', `contacts/${key}`, doc),
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
migrator.migrateLocalStorage('settings', 'app-settings');

// Array of documents
migrator.migrateLocalStorage('bookmarks', 'saved-bookmarks', { isArray: true });
```

No-ops if the key doesn't exist in localStorage or if `localStorage` is unavailable (e.g. Node.js). Throws an actionable error if the stored value is not valid JSON. Skips the write if no documents actually changed.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `isArray` | `boolean` | `false` | Treat the stored value as an array of documents |

---

### `migrator.getPending(collection, docs)`

Check which migrations are outstanding for a set of documents. Null and undefined entries in the array are silently skipped.

```js
const pending = migrator.getPending('contacts', allContacts);
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
migrator.getLatestVersion('contacts'); // 2
migrator.getLatestVersion('unknown'); // 0
```

## Putting it together

A typical setup: define migrations in one file, use them in your data layer.

**`migrations.js`** — register all migrations up front:

```js
import { createMigrator } from 'rs-migrate';

export const migrator = createMigrator();

// --- contacts ---
migrator.register({
  version: 1,
  collection: 'contacts',
  description: 'Split name into first/last',
  transform(doc) {
    if (doc.name && !doc.firstName) {
      const [first, ...rest] = doc.name.split(' ');
      doc.firstName = first;
      doc.lastName = rest.join(' ');
      delete doc.name;
    }
    return doc;
  },
});

migrator.register({
  version: 2,
  collection: 'contacts',
  description: 'Normalize email to array',
  transform(doc) {
    if (typeof doc.email === 'string') {
      doc.emails = [doc.email];
      delete doc.email;
    }
    return doc;
  },
});

// --- settings ---
migrator.register({
  version: 1,
  collection: 'settings',
  description: 'Remove deprecated theme options',
  transform(doc) {
    delete doc.legacyTheme;
    delete doc.useOldLayout;
    return doc;
  },
});
```

**`data.js`** — use the migrator when loading data:

```js
import { migrator } from './migrations.js';

// Lazy: migrate each document on read
function loadContact(raw) {
  return migrator.migrateDocument('contacts', raw);
}

// Eager: migrate all documents after sync
async function migrateAllContacts(client) {
  const results = await migrator.migrateAll('contacts', {
    getAll: () => client.getAll('contacts/'),
    save: (key, doc) => client.storeObject('contact', `contacts/${key}`, doc),
  });
  console.log(`Migrated ${results.length} contacts`);
}

// localStorage: migrate cached data in place
migrator.migrateLocalStorage('bookmarks', 'saved-bookmarks', { isArray: true });
```

## License

MIT
