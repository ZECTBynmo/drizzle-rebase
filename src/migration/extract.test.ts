import { describe, expect, test } from "bun:test"
import { extractManualSlots, validateSlotOrdering } from "./extract"
import type { ClassifiedMigration, Snapshot } from "../types"

function makeSnapshot(id: string, prevIds: string[] = []): Snapshot {
  return { version: "8", dialect: "postgres", id, prevIds, ddl: [], renames: [] }
}

function makeMigration(
  name: string,
  classification: "generated" | "manual" | "mixed",
  opts: { manualStatements?: string[]; snapshot?: Snapshot } = {},
): ClassifiedMigration {
  const timestamp = name.padStart(14, "0")
  return {
    dirName: `${timestamp}_${name}`,
    dirPath: `/tmp/test/${timestamp}_${name}`,
    sql: "",
    snapshot: opts.snapshot ?? makeSnapshot(`id-${name}`),
    timestamp,
    name,
    classification,
    manualStatements: opts.manualStatements ?? [],
  }
}

describe("extractManualSlots", () => {
  test("returns empty for all-generated migrations", () => {
    const migrations = [makeMigration("aaa", "generated"), makeMigration("bbb", "generated")]
    const slots = extractManualSlots(migrations)
    expect(slots).toHaveLength(0)
  })

  test("extracts manual slot", () => {
    const migrations = [
      makeMigration("aaa", "generated"),
      makeMigration("bbb", "manual", {
        manualStatements: ["UPDATE users SET email = 'test';"],
      }),
    ]
    const slots = extractManualSlots(migrations)
    expect(slots).toHaveLength(1)
    expect(slots[0]?.originalIndex).toBe(1)
    expect(slots[0]?.sql).toEqual(["UPDATE users SET email = 'test';"])
    expect(slots[0]?.classification).toBe("manual")
  })

  test("extracts mixed slot", () => {
    const migrations = [
      makeMigration("aaa", "mixed", {
        manualStatements: ["UPDATE users SET x = 1;"],
      }),
    ]
    const slots = extractManualSlots(migrations)
    expect(slots).toHaveLength(1)
    expect(slots[0]?.classification).toBe("mixed")
  })

  test("extracts multiple manual slots preserving order", () => {
    const migrations = [
      makeMigration("aaa", "generated"),
      makeMigration("bbb", "manual", { manualStatements: ["INSERT INTO log VALUES(1);"] }),
      makeMigration("ccc", "manual", { manualStatements: ["GRANT SELECT ON log TO app;"] }),
    ]
    const slots = extractManualSlots(migrations)
    expect(slots).toHaveLength(2)
    expect(slots[0]?.originalIndex).toBe(1)
    expect(slots[1]?.originalIndex).toBe(2)
  })
})

describe("validateSlotOrdering", () => {
  test("all generated is safe", () => {
    const migrations = [makeMigration("aaa", "generated"), makeMigration("bbb", "generated")]
    expect(validateSlotOrdering(migrations).safe).toBe(true)
  })

  test("manual at end is safe", () => {
    const migrations = [
      makeMigration("aaa", "generated"),
      makeMigration("bbb", "generated"),
      makeMigration("ccc", "manual"),
    ]
    expect(validateSlotOrdering(migrations).safe).toBe(true)
  })

  test("manual at start is safe", () => {
    const migrations = [
      makeMigration("aaa", "manual"),
      makeMigration("bbb", "generated"),
      makeMigration("ccc", "generated"),
    ]
    expect(validateSlotOrdering(migrations).safe).toBe(true)
  })

  test("manual between generated is dangerous", () => {
    const migrations = [
      makeMigration("aaa", "generated"),
      makeMigration("bbb", "manual", { manualStatements: ["UPDATE x SET y = 1;"] }),
      makeMigration("ccc", "generated"),
    ]
    const result = validateSlotOrdering(migrations)
    expect(result.safe).toBe(false)
    expect(result.problemSlot?.originalDirName).toContain("bbb")
  })

  test("mixed between generated is dangerous", () => {
    const migrations = [
      makeMigration("aaa", "generated"),
      makeMigration("bbb", "mixed", { manualStatements: ["UPDATE x SET y = 1;"] }),
      makeMigration("ccc", "generated"),
    ]
    const result = validateSlotOrdering(migrations)
    expect(result.safe).toBe(false)
  })

  test("G G M is safe (common pattern)", () => {
    const migrations = [
      makeMigration("aaa", "generated"),
      makeMigration("bbb", "generated"),
      makeMigration("ccc", "manual"),
    ]
    expect(validateSlotOrdering(migrations).safe).toBe(true)
  })

  test("G M G G is dangerous", () => {
    const migrations = [
      makeMigration("aaa", "generated"),
      makeMigration("bbb", "manual", { manualStatements: ["UPDATE x;"] }),
      makeMigration("ccc", "generated"),
      makeMigration("ddd", "generated"),
    ]
    expect(validateSlotOrdering(migrations).safe).toBe(false)
  })
})
