import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { backupMigrations, cleanupBackup, deleteMigrationDirs, restoreMigrations } from "./backup"
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

async function setupMigrationOnDisk(m: ClassifiedMigration): Promise<void> {
  await mkdir(m.dirPath, { recursive: true })
  await writeFile(join(m.dirPath, "migration.sql"), m.sql)
  await writeFile(join(m.dirPath, "snapshot.json"), JSON.stringify(m.snapshot, null, 2))
}

describe("disk-based backup and restore", () => {
  test("backup creates files on disk", async () => {
    const testDir = join(tmpdir(), `drizzle-rebase-test-backup-disk-${Date.now()}`)
    await mkdir(testDir, { recursive: true })

    const migrations = [makeMigration("aaa", testDir)]
    await setupMigrationOnDisk(migrations[0]!)

    const handle = await backupMigrations(testDir, migrations)

    expect(existsSync(handle.backupDir)).toBe(true)
    expect(handle.backedUpDirNames).toHaveLength(1)
    expect(handle.backedUpDirNames[0]).toContain("aaa")

    // Verify backup files exist
    const backupEntries = await readdir(handle.backupDir)
    expect(backupEntries).toContain(migrations[0]!.dirName)

    const backupSql = await readFile(
      join(handle.backupDir, migrations[0]!.dirName, "migration.sql"),
      "utf-8",
    )
    expect(backupSql).toContain("CREATE TABLE")

    await rm(testDir, { recursive: true })
  })

  test("delete + restore round-trips from disk backup", async () => {
    const testDir = join(tmpdir(), `drizzle-rebase-test-roundtrip-${Date.now()}`)
    await mkdir(testDir, { recursive: true })

    const migrations = [makeMigration("test_roundtrip", testDir)]
    await setupMigrationOnDisk(migrations[0]!)

    const handle = await backupMigrations(testDir, migrations)

    const deleted = await deleteMigrationDirs(migrations)
    expect(deleted).toHaveLength(1)

    const entriesAfterDelete = await readdir(testDir)
    expect(entriesAfterDelete).not.toContain(migrations[0]!.dirName)

    await restoreMigrations(testDir, handle)

    const entriesAfterRestore = await readdir(testDir)
    expect(entriesAfterRestore).toContain(migrations[0]!.dirName)

    const restoredSql = await readFile(
      join(migrations[0]!.dirPath, "migration.sql"),
      "utf-8",
    )
    expect(restoredSql).toBe(migrations[0]!.sql)

    await rm(testDir, { recursive: true })
  })

  test("cleanup removes backup directory", async () => {
    const testDir = join(tmpdir(), `drizzle-rebase-test-cleanup-${Date.now()}`)
    await mkdir(testDir, { recursive: true })

    const migrations = [makeMigration("cleanup_test", testDir)]
    await setupMigrationOnDisk(migrations[0]!)

    const handle = await backupMigrations(testDir, migrations)
    expect(existsSync(handle.backupDir)).toBe(true)

    await cleanupBackup(handle)
    expect(existsSync(handle.backupDir)).toBe(false)

    await rm(testDir, { recursive: true })
  })

  test("stale backup gets overwritten", async () => {
    const testDir = join(tmpdir(), `drizzle-rebase-test-stale-${Date.now()}`)
    await mkdir(testDir, { recursive: true })

    const migrations1 = [makeMigration("first", testDir)]
    await setupMigrationOnDisk(migrations1[0]!)

    const handle1 = await backupMigrations(testDir, migrations1)
    const entries1 = await readdir(handle1.backupDir)
    expect(entries1).toContain(migrations1[0]!.dirName)

    // Create a second migration and backup again (stale should be replaced)
    const migrations2 = [makeMigration("second", testDir)]
    await setupMigrationOnDisk(migrations2[0]!)

    const handle2 = await backupMigrations(testDir, migrations2)
    const entries2 = await readdir(handle2.backupDir)
    expect(entries2).toContain(migrations2[0]!.dirName)
    expect(entries2).not.toContain(migrations1[0]!.dirName)

    await rm(testDir, { recursive: true })
  })

  test("multiple migrations backed up and restored", async () => {
    const testDir = join(tmpdir(), `drizzle-rebase-test-multi-${Date.now()}`)
    await mkdir(testDir, { recursive: true })

    const migrations = [
      makeMigration("alpha", testDir),
      makeMigration("beta", testDir),
    ]
    for (const m of migrations) {
      await setupMigrationOnDisk(m)
    }

    const handle = await backupMigrations(testDir, migrations)
    expect(handle.backedUpDirNames).toHaveLength(2)

    await deleteMigrationDirs(migrations)

    for (const m of migrations) {
      expect(existsSync(m.dirPath)).toBe(false)
    }

    await restoreMigrations(testDir, handle)

    for (const m of migrations) {
      expect(existsSync(m.dirPath)).toBe(true)
      const sql = await readFile(join(m.dirPath, "migration.sql"), "utf-8")
      expect(sql).toBe(m.sql)
    }

    await rm(testDir, { recursive: true })
  })
})
