import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { applyDiff, diffSnapshots, isEmptyDiff, touchedTables } from "./diff"
import { parseSnapshot } from "./parse"
import type { SnapshotDiff } from "./diff"
import type { DdlEntity, Snapshot } from "../types"

const FIXTURES = join(import.meta.dir, "../__fixtures__")

describe("parseSnapshot", () => {
  test("parses a valid snapshot file", async () => {
    const snapshot = await parseSnapshot(join(FIXTURES, "20250101000000_initial/snapshot.json"))
    expect(snapshot.version).toBe("8")
    expect(snapshot.dialect).toBe("postgres")
    expect(snapshot.id).toBe("aaaa0000-0000-0000-0000-000000000001")
    expect(snapshot.ddl.length).toBeGreaterThan(0)
  })

  test("captures tables and columns", async () => {
    const snapshot = await parseSnapshot(join(FIXTURES, "20250101000000_initial/snapshot.json"))
    const tables = snapshot.ddl.filter((e) => e.entityType === "tables")
    const columns = snapshot.ddl.filter((e) => e.entityType === "columns")
    expect(tables).toHaveLength(1)
    expect(tables[0]?.name).toBe("users")
    expect(columns).toHaveLength(2)
  })
})

describe("diffSnapshots", () => {
  test("first migration shows all entities as added", async () => {
    const initial = await parseSnapshot(join(FIXTURES, "20250101000000_initial/snapshot.json"))
    const diff = diffSnapshots(null, initial)
    expect(diff.added.length).toBe(initial.ddl.length)
    expect(diff.removed).toHaveLength(0)
    expect(diff.modified).toHaveLength(0)
  })

  test("detects added column", async () => {
    const before = await parseSnapshot(join(FIXTURES, "20250101000000_initial/snapshot.json"))
    const after = await parseSnapshot(join(FIXTURES, "20250102000000_add_email/snapshot.json"))
    const diff = diffSnapshots(before, after)
    expect(diff.added).toHaveLength(1)
    expect(diff.added[0]?.entityType).toBe("columns")
    if (diff.added[0]?.entityType === "columns") {
      expect(diff.added[0].name).toBe("email")
    }
    expect(diff.removed).toHaveLength(0)
    expect(diff.modified).toHaveLength(0)
  })

  test("detects modified column (notNull change)", async () => {
    const before = await parseSnapshot(join(FIXTURES, "20250102000000_add_email/snapshot.json"))
    const after = await parseSnapshot(join(FIXTURES, "20250105000000_mixed_ddl_dml/snapshot.json"))
    const diff = diffSnapshots(before, after)
    expect(diff.modified).toHaveLength(1)
    expect(diff.modified[0]?.before.entityType).toBe("columns")
    if (diff.modified[0]?.before.entityType === "columns") {
      expect(diff.modified[0].before.notNull).toBe(false)
    }
    if (diff.modified[0]?.after.entityType === "columns") {
      expect(diff.modified[0].after.notNull).toBe(true)
    }
  })

  test("detects added index", async () => {
    const before = await parseSnapshot(join(FIXTURES, "20250105000000_mixed_ddl_dml/snapshot.json"))
    const after = await parseSnapshot(join(FIXTURES, "20250106000000_add_index/snapshot.json"))
    const diff = diffSnapshots(before, after)
    expect(diff.added).toHaveLength(1)
    expect(diff.added[0]?.entityType).toBe("indexes")
  })

  test("empty diff when snapshots are identical", async () => {
    const s1 = await parseSnapshot(join(FIXTURES, "20250102000000_add_email/snapshot.json"))
    const s2 = await parseSnapshot(join(FIXTURES, "20250103000000_backfill_emails/snapshot.json"))
    const diff = diffSnapshots(s1, s2)
    expect(isEmptyDiff(diff)).toBe(true)
  })

  test("empty diff for function-only migration", async () => {
    const s1 = await parseSnapshot(join(FIXTURES, "20250103000000_backfill_emails/snapshot.json"))
    const s2 = await parseSnapshot(join(FIXTURES, "20250104000000_create_function/snapshot.json"))
    const diff = diffSnapshots(s1, s2)
    expect(isEmptyDiff(diff)).toBe(true)
  })
})

describe("touchedTables", () => {
  test("identifies tables affected by column additions", async () => {
    const before = await parseSnapshot(join(FIXTURES, "20250101000000_initial/snapshot.json"))
    const after = await parseSnapshot(join(FIXTURES, "20250102000000_add_email/snapshot.json"))
    const diff = diffSnapshots(before, after)
    const tables = touchedTables(diff)
    expect(tables.has("users")).toBe(true)
    expect(tables.size).toBe(1)
  })

  test("returns empty set for identical snapshots", async () => {
    const s1 = await parseSnapshot(join(FIXTURES, "20250102000000_add_email/snapshot.json"))
    const s2 = await parseSnapshot(join(FIXTURES, "20250103000000_backfill_emails/snapshot.json"))
    const diff = diffSnapshots(s1, s2)
    const tables = touchedTables(diff)
    expect(tables.size).toBe(0)
  })
})

describe("applyDiff", () => {
  function makeSnapshot(id: string, ddl: DdlEntity[] = []): Snapshot {
    return { version: "8", dialect: "postgres", id, prevIds: [], ddl, renames: [] }
  }

  const usersTable: DdlEntity = {
    entityType: "tables",
    name: "users",
    schema: "public",
    isRlsEnabled: false,
  }

  const idColumn: DdlEntity = {
    entityType: "columns",
    name: "id",
    schema: "public",
    table: "users",
    type: "uuid",
    typeSchema: null,
    notNull: true,
    dimensions: 0,
    default: "gen_random_uuid()",
    generated: null,
    identity: null,
  }

  const emailColumn: DdlEntity = {
    entityType: "columns",
    name: "email",
    schema: "public",
    table: "users",
    type: "text",
    typeSchema: null,
    notNull: false,
    dimensions: 0,
    default: null,
    generated: null,
    identity: null,
  }

  const emailColumnNotNull: DdlEntity = {
    entityType: "columns",
    name: "email",
    schema: "public",
    table: "users",
    type: "text",
    typeSchema: null,
    notNull: true,
    dimensions: 0,
    default: null,
    generated: null,
    identity: null,
  }

  const ordersTable: DdlEntity = {
    entityType: "tables",
    name: "orders",
    schema: "public",
    isRlsEnabled: false,
  }

  test("apply add-only diff to a base merges entities", () => {
    const base = makeSnapshot("base-1", [usersTable, idColumn])
    const diff: SnapshotDiff = { added: [emailColumn], removed: [], modified: [] }

    const result = applyDiff(base, diff, "base-1")

    expect(result.conflicts).toHaveLength(0)
    expect(result.snapshot.ddl).toHaveLength(3)
    expect(result.snapshot.prevIds).toEqual(["base-1"])
    expect(result.snapshot.id).not.toBe("base-1")
    const names = result.snapshot.ddl.map((e) => e.name)
    expect(names).toContain("email")
  })

  test("apply remove diff removes entities", () => {
    const base = makeSnapshot("base-1", [usersTable, idColumn, emailColumn])
    const diff: SnapshotDiff = { added: [], removed: [emailColumn], modified: [] }

    const result = applyDiff(base, diff, "base-1")

    expect(result.conflicts).toHaveLength(0)
    expect(result.snapshot.ddl).toHaveLength(2)
    const names = result.snapshot.ddl.map((e) => e.name)
    expect(names).not.toContain("email")
  })

  test("apply modify diff updates entity", () => {
    const base = makeSnapshot("base-1", [usersTable, idColumn, emailColumn])
    const diff: SnapshotDiff = {
      added: [],
      removed: [],
      modified: [{ before: emailColumn, after: emailColumnNotNull }],
    }

    const result = applyDiff(base, diff, "base-1")

    expect(result.conflicts).toHaveLength(0)
    const emailEntity = result.snapshot.ddl.find(
      (e) => e.entityType === "columns" && e.name === "email",
    )
    expect(emailEntity).toBeDefined()
    if (emailEntity?.entityType === "columns") {
      expect(emailEntity.notNull).toBe(true)
    }
  })

  test("conflict: both add same entity with different properties", () => {
    // Base already has ordersTable; diff tries to add ordersTable with RLS enabled
    const ordersWithRls: DdlEntity = {
      entityType: "tables",
      name: "orders",
      schema: "public",
      isRlsEnabled: true,
    }
    const base = makeSnapshot("base-1", [usersTable, ordersTable])
    const diff: SnapshotDiff = { added: [ordersWithRls], removed: [], modified: [] }

    const result = applyDiff(base, diff, "base-1")

    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]?.type).toBe("add-exists")
  })

  test("conflict: they modified entity, I also modify same entity", () => {
    // Diff expects emailColumn as before, but base has emailColumnNotNull (they modified it)
    const emailColumnWithDefault: DdlEntity = {
      entityType: "columns",
      name: "email",
      schema: "public",
      table: "users",
      type: "text",
      typeSchema: null,
      notNull: false,
      dimensions: 0,
      default: "'unknown'",
      generated: null,
      identity: null,
    }
    const base = makeSnapshot("base-1", [usersTable, idColumn, emailColumnNotNull])
    const diff: SnapshotDiff = {
      added: [],
      removed: [],
      modified: [{ before: emailColumn, after: emailColumnWithDefault }],
    }

    const result = applyDiff(base, diff, "base-1")

    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]?.type).toBe("modify-diverged")
  })

  test("empty diff applied returns snapshot identical to base (with new id/prevIds)", () => {
    const base = makeSnapshot("base-1", [usersTable, idColumn])
    const diff: SnapshotDiff = { added: [], removed: [], modified: [] }

    const result = applyDiff(base, diff, "base-1")

    expect(result.conflicts).toHaveLength(0)
    expect(result.snapshot.ddl).toEqual(base.ddl)
    expect(result.snapshot.id).not.toBe(base.id)
    expect(result.snapshot.prevIds).toEqual(["base-1"])
  })

  test("apply to null base: all additions become the snapshot", () => {
    const diff: SnapshotDiff = { added: [usersTable, idColumn], removed: [], modified: [] }

    const result = applyDiff(null, diff, "")

    expect(result.conflicts).toHaveLength(0)
    expect(result.snapshot.ddl).toHaveLength(2)
    expect(result.snapshot.prevIds).toEqual([""])
  })

  test("adding entity identical to existing is silently skipped", () => {
    const base = makeSnapshot("base-1", [usersTable, idColumn, emailColumn])
    const diff: SnapshotDiff = { added: [emailColumn], removed: [], modified: [] }

    const result = applyDiff(base, diff, "base-1")

    expect(result.conflicts).toHaveLength(0)
    expect(result.snapshot.ddl).toHaveLength(3)
  })

  test("conflict: remove entity that was modified by them", () => {
    // Base has emailColumnNotNull (they modified it), diff tries to remove emailColumn (original)
    const base = makeSnapshot("base-1", [usersTable, idColumn, emailColumnNotNull])
    const diff: SnapshotDiff = { added: [], removed: [emailColumn], modified: [] }

    const result = applyDiff(base, diff, "base-1")

    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]?.type).toBe("remove-modified")
    expect(result.conflicts[0]?.entityKey).toContain("email")
    // Entity should still be in the snapshot (not removed due to conflict)
    const names = result.snapshot.ddl.map((e) => e.name)
    expect(names).toContain("email")
  })

  test("removing entity that doesn't exist is silently skipped", () => {
    const base = makeSnapshot("base-1", [usersTable, idColumn])
    const diff: SnapshotDiff = { added: [], removed: [emailColumn], modified: [] }

    const result = applyDiff(base, diff, "base-1")

    expect(result.conflicts).toHaveLength(0)
    expect(result.snapshot.ddl).toHaveLength(2)
  })
})

