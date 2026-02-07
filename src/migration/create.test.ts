import { describe, expect, test } from "bun:test"
import { mkdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createMigrationDir, nextTimestamp } from "./create"
import type { Snapshot } from "../types"

function makeSnapshot(id: string): Snapshot {
  return { version: "8", dialect: "postgres", id, prevIds: [], ddl: [], renames: [] }
}

describe("nextTimestamp", () => {
  test("increments by 1", () => {
    expect(nextTimestamp("20250101000000", [])).toBe("20250101000001")
  })

  test("skips collisions", () => {
    expect(nextTimestamp("20250101000000", ["20250101000001"])).toBe("20250101000002")
  })

  test("skips multiple collisions", () => {
    expect(nextTimestamp("20250101000000", ["20250101000001", "20250101000002"])).toBe(
      "20250101000003",
    )
  })
})

describe("createMigrationDir", () => {
  const testDir = join(tmpdir(), `drizzle-rebase-test-create-${Date.now()}`)

  test("creates migration directory with correct files", async () => {
    await mkdir(testDir, { recursive: true })

    const snapshot = makeSnapshot("test-id")
    const result = await createMigrationDir({
      migrationsDir: testDir,
      name: "backfill_emails",
      sql: "UPDATE users SET email = 'test';",
      snapshot,
      afterTimestamp: "20250101000000",
    })

    expect(result.dirName).toBe("20250101000001_backfill_emails")
    expect(result.timestamp).toBe("20250101000001")

    const sqlContent = await readFile(join(result.dirPath, "migration.sql"), "utf-8")
    expect(sqlContent).toBe("UPDATE users SET email = 'test';")

    const snapContent = JSON.parse(
      await readFile(join(result.dirPath, "snapshot.json"), "utf-8"),
    ) as Snapshot
    expect(snapContent.id).toBe("test-id")

    await rm(testDir, { recursive: true })
  })

  test("avoids collision with existing directory", async () => {
    await mkdir(testDir, { recursive: true })
    await mkdir(join(testDir, "20250101000001_existing"), { recursive: true })

    const snapshot = makeSnapshot("test-id")
    const result = await createMigrationDir({
      migrationsDir: testDir,
      name: "backfill",
      sql: "UPDATE x;",
      snapshot,
      afterTimestamp: "20250101000000",
    })

    expect(result.timestamp).toBe("20250101000002")

    await rm(testDir, { recursive: true })
  })
})
