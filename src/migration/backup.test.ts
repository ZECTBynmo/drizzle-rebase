import { describe, expect, test } from "bun:test"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { backupMigrations, deleteMigrationDirs, restoreMigrations } from "./backup"
import type { ClassifiedMigration, Snapshot } from "../types"

function makeSnapshot(id: string): Snapshot {
  return { version: "8", dialect: "postgres", id, prevIds: [], ddl: [], renames: [] }
}

function makeMigration(name: string, dir: string): ClassifiedMigration {
  const timestamp = name.padStart(14, "0")
  return {
    dirName: `${timestamp}_${name}`,
    dirPath: join(dir, `${timestamp}_${name}`),
    sql: `CREATE TABLE "${name}" (id uuid PRIMARY KEY);`,
    snapshot: makeSnapshot(`id-${name}`),
    timestamp,
    name,
    classification: "generated",
    manualStatements: [],
  }
}

describe("backup and restore", () => {
  const testDir = join(tmpdir(), `drizzle-rebase-test-backup-${Date.now()}`)

  test("backup captures migration data", () => {
    const migrations = [makeMigration("aaa", testDir)]
    const backups = backupMigrations(migrations)
    expect(backups).toHaveLength(1)
    expect(backups[0]?.dirName).toContain("aaa")
    expect(backups[0]?.sql).toContain("CREATE TABLE")
    expect(backups[0]?.snapshot.id).toBe("id-aaa")
  })

  test("backup creates deep copy of snapshot", () => {
    const migrations = [makeMigration("aaa", testDir)]
    const backups = backupMigrations(migrations)
    const backup = backups[0]
    const migration = migrations[0]
    expect(backup).toBeDefined()
    expect(migration).toBeDefined()
    if (backup && migration) {
      expect(backup.snapshot).not.toBe(migration.snapshot)
      expect(backup.snapshot).toEqual(migration.snapshot)
    }
  })

  test("delete + restore round-trips", async () => {
    await mkdir(testDir, { recursive: true })
    const migrations = [makeMigration("test_roundtrip", testDir)]
    const m = migrations[0]
    expect(m).toBeDefined()
    if (!m) return

    await mkdir(m.dirPath, { recursive: true })
    await writeFile(join(m.dirPath, "migration.sql"), m.sql)
    await writeFile(join(m.dirPath, "snapshot.json"), JSON.stringify(m.snapshot))

    const backups = backupMigrations(migrations)

    const deleted = await deleteMigrationDirs(migrations)
    expect(deleted).toHaveLength(1)

    const entriesAfterDelete = await readdir(testDir)
    expect(entriesAfterDelete).not.toContain(m.dirName)

    await restoreMigrations(backups)

    const entriesAfterRestore = await readdir(testDir)
    expect(entriesAfterRestore).toContain(m.dirName)

    const restoredSql = await readFile(join(m.dirPath, "migration.sql"), "utf-8")
    expect(restoredSql).toBe(m.sql)

    await rm(testDir, { recursive: true })
  })
})
