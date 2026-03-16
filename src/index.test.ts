import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMigrator } from "./index.js";

describe("createMigrator", () => {
  it("returns an object with all expected methods", () => {
    const m = createMigrator();
    expect(typeof m.register).toBe("function");
    expect(typeof m.registerAll).toBe("function");
    expect(typeof m.migrateDocument).toBe("function");
    expect(typeof m.migrateAll).toBe("function");
    expect(typeof m.migrateLocalStorage).toBe("function");
    expect(typeof m.getPending).toBe("function");
    expect(typeof m.getLatestVersion).toBe("function");
  });
});

describe("register", () => {
  it("registers a migration successfully", () => {
    const m = createMigrator();
    m.register({
      version: 1,
      collection: "songs",
      description: "test",
      transform: (d: any) => d,
    });
    expect(m.getLatestVersion("songs")).toBe(1);
  });

  it("throws on duplicate version within same collection", () => {
    const m = createMigrator();
    m.register({
      version: 1,
      collection: "songs",
      description: "first",
      transform: (d: any) => d,
    });
    expect(() =>
      m.register({
        version: 1,
        collection: "songs",
        description: "dupe",
        transform: (d: any) => d,
      }),
    ).toThrow(/Duplicate migration version 1/);
  });

  it("allows same version across different collections", () => {
    const m = createMigrator();
    m.register({
      version: 1,
      collection: "songs",
      description: "a",
      transform: (d: any) => d,
    });
    m.register({
      version: 1,
      collection: "config",
      description: "b",
      transform: (d: any) => d,
    });
    expect(m.getLatestVersion("songs")).toBe(1);
    expect(m.getLatestVersion("config")).toBe(1);
  });

  it("throws on non-positive-integer version", () => {
    const m = createMigrator();
    const base = {
      collection: "x",
      description: "t",
      transform: (d: any) => d,
    };
    expect(() => m.register({ ...base, version: 0 })).toThrow(
      /positive integer/,
    );
    expect(() => m.register({ ...base, version: -1 })).toThrow(
      /positive integer/,
    );
    expect(() => m.register({ ...base, version: 1.5 })).toThrow(
      /positive integer/,
    );
  });
});

describe("registerAll", () => {
  it("registers multiple migrations", () => {
    const m = createMigrator();
    m.registerAll([
      {
        version: 1,
        collection: "songs",
        description: "a",
        transform: (d: any) => d,
      },
      {
        version: 2,
        collection: "songs",
        description: "b",
        transform: (d: any) => d,
      },
    ]);
    expect(m.getLatestVersion("songs")).toBe(2);
  });

  it("throws on duplicate within batch", () => {
    const m = createMigrator();
    expect(() =>
      m.registerAll([
        {
          version: 1,
          collection: "songs",
          description: "a",
          transform: (d: any) => d,
        },
        {
          version: 1,
          collection: "songs",
          description: "b",
          transform: (d: any) => d,
        },
      ]),
    ).toThrow(/Duplicate/);
  });
});

describe("migrateDocument", () => {
  it("migrates from version 0 to latest", () => {
    const m = createMigrator();
    m.register({
      version: 1,
      collection: "songs",
      description: "add title",
      transform: (d: any) => ({ ...d, title: "untitled" }),
    });
    m.register({
      version: 2,
      collection: "songs",
      description: "add artist",
      transform: (d: any) => ({ ...d, artist: "unknown" }),
    });

    const doc = { name: "test" };
    const result = m.migrateDocument("songs", doc);
    expect(result.title).toBe("untitled");
    expect(result.artist).toBe("unknown");
    expect(result._migrateVersion).toBe(2);
  });

  it("migrates from intermediate version", () => {
    const m = createMigrator();
    m.register({
      version: 1,
      collection: "songs",
      description: "a",
      transform: (d: any) => ({ ...d, v1: true }),
    });
    m.register({
      version: 2,
      collection: "songs",
      description: "b",
      transform: (d: any) => ({ ...d, v2: true }),
    });

    const doc = { _migrateVersion: 1 };
    const result = m.migrateDocument("songs", doc);
    expect(result.v1).toBeUndefined();
    expect(result.v2).toBe(true);
    expect(result._migrateVersion).toBe(2);
  });

  it("returns original reference if already at latest", () => {
    const m = createMigrator();
    m.register({
      version: 1,
      collection: "songs",
      description: "a",
      transform: (d: any) => d,
    });

    const doc = { _migrateVersion: 1 };
    const result = m.migrateDocument("songs", doc);
    expect(result).toBe(doc);
  });

  it("returns original if no migrations registered for collection", () => {
    const m = createMigrator();
    const doc = { foo: "bar" };
    expect(m.migrateDocument("unknown", doc)).toBe(doc);
  });

  it("deep-clones before transforming", () => {
    const m = createMigrator();
    m.register({
      version: 1,
      collection: "songs",
      description: "mutate",
      transform: (d: any) => {
        d.nested.value = "changed";
        return d;
      },
    });

    const doc = { nested: { value: "original" } };
    const result = m.migrateDocument("songs", doc);
    expect(result.nested.value).toBe("changed");
    expect(doc.nested.value).toBe("original");
  });

  it("respects custom versionField", () => {
    const m = createMigrator({ versionField: "schemaVersion" });
    m.register({
      version: 2,
      collection: "songs",
      description: "upgrade",
      transform: (d: any) => ({ ...d, upgraded: true }),
    });

    const doc = { schemaVersion: 1 };
    const result = m.migrateDocument("songs", doc);
    expect(result.upgraded).toBe(true);
    expect(result.schemaVersion).toBe(2);
  });

  it("runs migrations in version order regardless of registration order", () => {
    const m = createMigrator();
    const order: number[] = [];

    m.register({
      version: 3,
      collection: "songs",
      description: "third",
      transform: (d: any) => {
        order.push(3);
        return d;
      },
    });
    m.register({
      version: 1,
      collection: "songs",
      description: "first",
      transform: (d: any) => {
        order.push(1);
        return d;
      },
    });
    m.register({
      version: 2,
      collection: "songs",
      description: "second",
      transform: (d: any) => {
        order.push(2);
        return d;
      },
    });

    m.migrateDocument("songs", {});
    expect(order).toEqual([1, 2, 3]);
  });
});

describe("migrateAll", () => {
  it("migrates docs and calls save only for changed ones", async () => {
    const m = createMigrator();
    m.register({
      version: 1,
      collection: "songs",
      description: "add flag",
      transform: (d: any) => ({ ...d, migrated: true }),
    });

    const saved: Array<[string, any]> = [];
    const results = await m.migrateAll("songs", {
      getAll: async () => ({
        a: { name: "song-a" },
        b: { name: "song-b", _migrateVersion: 1 },
      }),
      save: async (key, doc) => {
        saved.push([key, doc]);
      },
    });

    expect(results).toHaveLength(1);
    expect(results[0].key).toBe("a");
    expect(results[0].fromVersion).toBe(0);
    expect(results[0].toVersion).toBe(1);
    expect(saved).toHaveLength(1);
    expect(saved[0][0]).toBe("a");
  });

  it("handles empty getAll result", async () => {
    const m = createMigrator();
    m.register({
      version: 1,
      collection: "songs",
      description: "a",
      transform: (d: any) => d,
    });

    const results = await m.migrateAll("songs", {
      getAll: async () => ({}),
      save: async () => {},
    });
    expect(results).toHaveLength(0);
  });
});

describe("migrateLocalStorage", () => {
  let storage: Record<string, string>;

  beforeEach(() => {
    storage = {};
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => {
        storage[key] = value;
      },
    });
  });

  it("migrates a single object", () => {
    const m = createMigrator();
    m.register({
      version: 1,
      collection: "config",
      description: "add flag",
      transform: (d: any) => ({ ...d, flag: true }),
    });

    storage["myConfig"] = JSON.stringify({ name: "test" });
    m.migrateLocalStorage("config", "myConfig");

    const result = JSON.parse(storage["myConfig"]);
    expect(result.flag).toBe(true);
    expect(result._migrateVersion).toBe(1);
  });

  it("migrates an array of docs with isArray", () => {
    const m = createMigrator();
    m.register({
      version: 1,
      collection: "setlists",
      description: "add flag",
      transform: (d: any) => ({ ...d, clean: true }),
    });

    storage["sets"] = JSON.stringify([{ name: "a" }, { name: "b" }]);
    m.migrateLocalStorage("setlists", "sets", { isArray: true });

    const result = JSON.parse(storage["sets"]);
    expect(result).toHaveLength(2);
    expect(result[0].clean).toBe(true);
    expect(result[1].clean).toBe(true);
  });

  it("no-ops when key is missing", () => {
    const m = createMigrator();
    m.register({
      version: 1,
      collection: "config",
      description: "a",
      transform: (d: any) => d,
    });

    m.migrateLocalStorage("config", "nonexistent");
    expect(storage["nonexistent"]).toBeUndefined();
  });
});

describe("getPending", () => {
  it("returns pending migrations for docs at various versions", () => {
    const m = createMigrator();
    const mig1 = {
      version: 1,
      collection: "songs",
      description: "a",
      transform: (d: any) => d,
    };
    const mig2 = {
      version: 2,
      collection: "songs",
      description: "b",
      transform: (d: any) => d,
    };
    m.registerAll([mig1, mig2]);

    const docs = [
      {},
      { _migrateVersion: 1 },
      { _migrateVersion: 2 },
    ];

    const pending = m.getPending("songs", docs);
    expect(pending[0].currentVersion).toBe(0);
    expect(pending[0].pendingMigrations).toHaveLength(2);
    expect(pending[1].currentVersion).toBe(1);
    expect(pending[1].pendingMigrations).toHaveLength(1);
    expect(pending[2].currentVersion).toBe(2);
    expect(pending[2].pendingMigrations).toHaveLength(0);
  });
});

describe("getLatestVersion", () => {
  it("returns highest registered version", () => {
    const m = createMigrator();
    m.registerAll([
      {
        version: 1,
        collection: "songs",
        description: "a",
        transform: (d: any) => d,
      },
      {
        version: 3,
        collection: "songs",
        description: "c",
        transform: (d: any) => d,
      },
    ]);
    expect(m.getLatestVersion("songs")).toBe(3);
  });

  it("returns 0 for unknown collection", () => {
    const m = createMigrator();
    expect(m.getLatestVersion("nope")).toBe(0);
  });
});
