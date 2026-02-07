import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { diffSnapshots, isEmptyDiff, touchedTables } from "./diff"
import { parseSnapshot } from "./parse"

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
