export interface MigrationDescriptor {
  version: number;
  collection: string;
  description: string;
  transform: (doc: any) => any;
}

export interface MigrateAllAdapter {
  getAll: () => Promise<Record<string, any>>;
  save: (key: string, doc: any) => Promise<void>;
}

export interface MigrateResult {
  key: string;
  doc: any;
  fromVersion: number;
  toVersion: number;
  migrationsApplied: number;
}

export interface PendingInfo {
  doc: any;
  currentVersion: number;
  pendingMigrations: MigrationDescriptor[];
}

export interface MigrateLocalStorageOptions {
  isArray?: boolean;
}

export interface MigratorOptions {
  versionField?: string;
}

export interface Migrator {
  register(migration: MigrationDescriptor): void;
  registerAll(migrations: MigrationDescriptor[]): void;
  migrateDocument(collection: string, doc: any): any;
  migrateAll(
    collection: string,
    adapter: MigrateAllAdapter,
  ): Promise<MigrateResult[]>;
  migrateLocalStorage(
    collection: string,
    key: string,
    opts?: MigrateLocalStorageOptions,
  ): void;
  getPending(collection: string, docs: any[]): PendingInfo[];
  getLatestVersion(collection: string): number;
}

export function createMigrator(options?: MigratorOptions): Migrator {
  const versionField = options?.versionField ?? "_migrateVersion";
  const registry = new Map<string, MigrationDescriptor[]>();

  function getMigrations(collection: string): MigrationDescriptor[] {
    return registry.get(collection) ?? [];
  }

  function register(migration: MigrationDescriptor): void {
    const { version, collection } = migration;
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(
        `Migration version must be a positive integer, got ${version}`,
      );
    }
    const existing = registry.get(collection) ?? [];
    if (existing.some((m) => m.version === version)) {
      throw new Error(
        `Duplicate migration version ${version} for collection "${collection}"`,
      );
    }
    existing.push(migration);
    existing.sort((a, b) => a.version - b.version);
    registry.set(collection, existing);
  }

  function registerAll(migrations: MigrationDescriptor[]): void {
    // Pre-validate the entire batch before mutating the registry
    for (const m of migrations) {
      const { version, collection } = m;
      if (!Number.isInteger(version) || version < 1) {
        throw new Error(
          `Migration version must be a positive integer, got ${version}`,
        );
      }
      const existing = registry.get(collection) ?? [];
      if (existing.some((e) => e.version === version)) {
        throw new Error(
          `Duplicate migration version ${version} for collection "${collection}"`,
        );
      }
      // Check for duplicates within the batch itself
      const dupeInBatch = migrations.filter(
        (other) => other !== m && other.collection === collection && other.version === version,
      );
      if (dupeInBatch.length > 0) {
        throw new Error(
          `Duplicate migration version ${version} for collection "${collection}"`,
        );
      }
    }
    // All valid — commit to registry
    for (const m of migrations) {
      register(m);
    }
  }

  function migrateDocument(collection: string, doc: any): any {
    const migrations = getMigrations(collection);
    if (migrations.length === 0) return doc;

    const currentVersion: number = doc[versionField] ?? 0;
    const pending = migrations.filter((m) => m.version > currentVersion);
    if (pending.length === 0) return doc;

    let clone = structuredClone(doc);
    for (const m of pending) {
      clone = m.transform(clone);
    }
    clone[versionField] = pending[pending.length - 1].version;
    return clone;
  }

  async function migrateAll(
    collection: string,
    adapter: MigrateAllAdapter,
  ): Promise<MigrateResult[]> {
    const docs = await adapter.getAll();
    const results: MigrateResult[] = [];

    const migrations = getMigrations(collection);
    for (const [key, doc] of Object.entries(docs)) {
      if (!doc || typeof doc !== "object") continue;
      const fromVersion: number = doc[versionField] ?? 0;
      const migrated = migrateDocument(collection, doc);
      if (migrated !== doc) {
        await adapter.save(key, migrated);
        const applied = migrations.filter((m) => m.version > fromVersion).length;
        results.push({
          key,
          doc: migrated,
          fromVersion,
          toVersion: migrated[versionField] ?? 0,
          migrationsApplied: applied,
        });
      }
    }

    return results;
  }

  function migrateLocalStorage(
    collection: string,
    key: string,
    opts?: MigrateLocalStorageOptions,
  ): void {
    if (typeof localStorage === "undefined") return;

    const raw = localStorage.getItem(key);
    if (raw === null) return;

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `Failed to parse localStorage key "${key}" for collection "${collection}": invalid JSON`,
      );
    }

    if (opts?.isArray) {
      const items = parsed as any[];
      const migrated = items.map((item) => migrateDocument(collection, item));
      const changed = migrated.some((doc, i) => doc !== items[i]);
      if (changed) {
        localStorage.setItem(key, JSON.stringify(migrated));
      }
    } else {
      const migrated = migrateDocument(collection, parsed);
      if (migrated !== parsed) {
        localStorage.setItem(key, JSON.stringify(migrated));
      }
    }
  }

  function getPending(collection: string, docs: any[]): PendingInfo[] {
    const migrations = getMigrations(collection);
    return docs
      .filter((doc) => doc != null && typeof doc === "object")
      .map((doc) => {
        const currentVersion: number = doc[versionField] ?? 0;
        const pendingMigrations = migrations.filter(
          (m) => m.version > currentVersion,
        );
        return { doc, currentVersion, pendingMigrations };
      });
  }

  function getLatestVersion(collection: string): number {
    const migrations = getMigrations(collection);
    if (migrations.length === 0) return 0;
    return migrations[migrations.length - 1].version;
  }

  return {
    register,
    registerAll,
    migrateDocument,
    migrateAll,
    migrateLocalStorage,
    getPending,
    getLatestVersion,
  };
}
