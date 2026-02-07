import { describe, expect, test } from "bun:test"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { formatRebaseResult } from "./run"
import { backupMigrations, deleteMigrationDirs } from "../migration/backup"
import { extractManualSlots, validateSlotOrdering } from "../migration/extract"
import { createMigrationDir } from "../migration/create"
import { buildSnapshotForManualDir, repairSnapshotChain } from "../snapshot/chain"
import type { ClassifiedMigration, RebaseResult, Snapshot } from "../types"

function makeSnapshot(id: string, prevIds: string[], ddl: Snapshot["ddl"] = []): Snapshot {
  return { version: "8", dialect: "postgres", id, prevIds, ddl, renames: [] }
}

const TABLE_DDL: Snapshot["ddl"] = [
  { entityType: "tables", name: "users", schema: "public", isRlsEnabled: false },
  {
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
  },
]

const TABLE_WITH_EMAIL_DDL: Snapshot["ddl"] = [
  ...TABLE_DDL,
  {
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
  },
]

const TABLE_WITH_EMAIL_NOTNULL_DDL: Snapshot["ddl"] = [
  ...TABLE_DDL,
  {
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
  },
]

describe("formatRebaseResult", () => {
  test("formats success with all sections", () => {
    const result: RebaseResult = {
      deleted: ["20250101000000_add_email", "20250102000000_backfill"],
      generated: ["20250103000000_add_email"],
      manualDirs: ["20250104000000_backfill"],
      success: true,
    }
    const output = formatRebaseResult(result)
    expect(output).toContain("Deleted migrations:")
    expect(output).toContain("  - 20250101000000_add_email")
    expect(output).toContain("Regenerated migrations:")
    expect(output).toContain("  + 20250103000000_add_email")
    expect(output).toContain("Manual SQL migrations created:")
    expect(output).toContain("  ~ 20250104000000_backfill")
    expect(output).toContain("Rebase complete.")
  })

  test("formats failure", () => {
    const result: RebaseResult = {
      deleted: [],
      generated: [],
      manualDirs: [],
      success: false,
      error: "something broke",
    }
    const output = formatRebaseResult(result)
    expect(output).toContain("Rebase failed: something broke")
  })

  test("formats nothing to do", () => {
    const result: RebaseResult = {
      deleted: [],
      generated: [],
      manualDirs: [],
      success: true,
    }
    const output = formatRebaseResult(result)
    expect(output).toContain("Nothing to do.")
  })

  test("formats generated-only rebase (no manual)", () => {
    const result: RebaseResult = {
      deleted: ["20250101000000_old"],
      generated: ["20250102000000_new"],
      manualDirs: [],
      success: true,
    }
    const output = formatRebaseResult(result)
    expect(output).toContain("Deleted migrations:")
    expect(output).toContain("Regenerated migrations:")
    expect(output).not.toContain("Manual SQL")
    expect(output).toContain("Rebase complete.")
  })
})

describe("splice integration", () => {
  test("full splice flow: backup, delete, create manual dirs, repair chain", async () => {
    const testDir = join(tmpdir(), `drizzle-rebase-splice-${Date.now()}`)
    await mkdir(testDir, { recursive: true })

    const theirSnap = makeSnapshot("their-1", [], TABLE_DDL)
    const theirDir = join(testDir, "20250101000000_initial")
    await mkdir(theirDir, { recursive: true })
    await writeFile(join(theirDir, "migration.sql"), 'CREATE TABLE "users" ("id" uuid);')
    await writeFile(join(theirDir, "snapshot.json"), JSON.stringify(theirSnap, null, 2))

    const myGenSnap = makeSnapshot("my-gen-1", ["their-1"], TABLE_WITH_EMAIL_DDL)
    const myManualSnap = makeSnapshot("my-manual-1", ["my-gen-1"], TABLE_WITH_EMAIL_DDL)
    const myGen2Snap = makeSnapshot("my-gen-2", ["my-manual-1"], TABLE_WITH_EMAIL_NOTNULL_DDL)

    const myMigrations: ClassifiedMigration[] = [
      {
        dirName: "20250102000000_add_email",
        dirPath: join(testDir, "20250102000000_add_email"),
        sql: 'ALTER TABLE "users" ADD COLUMN "email" text;',
        snapshot: myGenSnap,
        timestamp: "20250102000000",
        name: "add_email",
        classification: "generated",
        manualStatements: [],
      },
      {
        dirName: "20250103000000_backfill_emails",
        dirPath: join(testDir, "20250103000000_backfill_emails"),
        sql: 'UPDATE "users" SET "email" = \'test@test.com\' WHERE "email" IS NULL;',
        snapshot: myManualSnap,
        timestamp: "20250103000000",
        name: "backfill_emails",
        classification: "manual",
        manualStatements: ['UPDATE "users" SET "email" = \'test@test.com\' WHERE "email" IS NULL;'],
      },
      {
        dirName: "20250104000000_email_not_null",
        dirPath: join(testDir, "20250104000000_email_not_null"),
        sql: 'ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL;',
        snapshot: myGen2Snap,
        timestamp: "20250104000000",
        name: "email_not_null",
        classification: "generated",
        manualStatements: [],
      },
    ]

    for (const m of myMigrations) {
      await mkdir(m.dirPath, { recursive: true })
      await writeFile(join(m.dirPath, "migration.sql"), m.sql)
      await writeFile(join(m.dirPath, "snapshot.json"), JSON.stringify(m.snapshot, null, 2))
    }

    const check = validateSlotOrdering(myMigrations)
    expect(check.safe).toBe(false)
    expect(check.problemSlot?.originalDirName).toBe("20250103000000_backfill_emails")

    await rm(testDir, { recursive: true })
  })

  test("safe flow: G G M - splice manual after regenerated", async () => {
    const testDir = join(tmpdir(), `drizzle-rebase-safe-splice-${Date.now()}`)
    await mkdir(testDir, { recursive: true })

    const theirSnap = makeSnapshot("their-1", [], TABLE_DDL)
    const theirDir = join(testDir, "20250101000000_initial")
    await mkdir(theirDir, { recursive: true })
    await writeFile(join(theirDir, "migration.sql"), 'CREATE TABLE "users" ("id" uuid);')
    await writeFile(join(theirDir, "snapshot.json"), JSON.stringify(theirSnap, null, 2))

    const myGenSnap = makeSnapshot("my-gen-1", ["their-1"], TABLE_WITH_EMAIL_DDL)
    const myManualSnap = makeSnapshot("my-manual-1", ["my-gen-1"], TABLE_WITH_EMAIL_DDL)

    const myMigrations: ClassifiedMigration[] = [
      {
        dirName: "20250102000000_add_email",
        dirPath: join(testDir, "20250102000000_add_email"),
        sql: 'ALTER TABLE "users" ADD COLUMN "email" text;',
        snapshot: myGenSnap,
        timestamp: "20250102000000",
        name: "add_email",
        classification: "generated",
        manualStatements: [],
      },
      {
        dirName: "20250103000000_backfill_emails",
        dirPath: join(testDir, "20250103000000_backfill_emails"),
        sql: 'UPDATE "users" SET "email" = \'test@test.com\' WHERE "email" IS NULL;',
        snapshot: myManualSnap,
        timestamp: "20250103000000",
        name: "backfill_emails",
        classification: "manual",
        manualStatements: ['UPDATE "users" SET "email" = \'test@test.com\' WHERE "email" IS NULL;'],
      },
    ]

    for (const m of myMigrations) {
      await mkdir(m.dirPath, { recursive: true })
      await writeFile(join(m.dirPath, "migration.sql"), m.sql)
      await writeFile(join(m.dirPath, "snapshot.json"), JSON.stringify(m.snapshot, null, 2))
    }

    const check = validateSlotOrdering(myMigrations)
    expect(check.safe).toBe(true)

    const slots = extractManualSlots(myMigrations)
    expect(slots).toHaveLength(1)
    expect(slots[0]?.sql).toEqual([
      'UPDATE "users" SET "email" = \'test@test.com\' WHERE "email" IS NULL;',
    ])

    const backups = backupMigrations(myMigrations)
    expect(backups).toHaveLength(2)

    await deleteMigrationDirs(myMigrations)

    const afterDelete = await readdir(testDir)
    expect(afterDelete).toContain("20250101000000_initial")
    expect(afterDelete).not.toContain("20250102000000_add_email")
    expect(afterDelete).not.toContain("20250103000000_backfill_emails")

    const regenSnap = makeSnapshot("regen-1", ["their-1"], TABLE_WITH_EMAIL_DDL)
    const regenDir = join(testDir, "20250110000000_add_email")
    await mkdir(regenDir, { recursive: true })
    await writeFile(join(regenDir, "migration.sql"), 'ALTER TABLE "users" ADD COLUMN "email" text;')
    await writeFile(join(regenDir, "snapshot.json"), JSON.stringify(regenSnap, null, 2))

    const slot = slots[0]
    if (!slot) throw new Error("Expected a manual slot")
    const manualSnapshot = buildSnapshotForManualDir(regenSnap)
    const sqlContent = slot.sql.join("\n\n") + "\n"

    const created = await createMigrationDir({
      migrationsDir: testDir,
      name: "backfill_emails",
      sql: sqlContent,
      snapshot: manualSnapshot,
      afterTimestamp: "20250110000000",
    })

    expect(created.dirName).toBe("20250110000001_backfill_emails")

    await repairSnapshotChain(testDir, "20250101000000")

    const finalEntries = (await readdir(testDir)).filter((e) => /^\d{14}_/.test(e)).sort()
    expect(finalEntries).toHaveLength(3)
    expect(finalEntries[0]).toBe("20250101000000_initial")
    expect(finalEntries[1]).toBe("20250110000000_add_email")
    expect(finalEntries[2]).toBe("20250110000001_backfill_emails")

    const [entry0, entry1, entry2] = finalEntries
    if (!entry0 || !entry1 || !entry2) throw new Error("Expected 3 entries")

    const snap1 = JSON.parse(
      await readFile(join(testDir, entry0, "snapshot.json"), "utf-8"),
    ) as Snapshot
    const snap2 = JSON.parse(
      await readFile(join(testDir, entry1, "snapshot.json"), "utf-8"),
    ) as Snapshot
    const snap3 = JSON.parse(
      await readFile(join(testDir, entry2, "snapshot.json"), "utf-8"),
    ) as Snapshot

    expect(snap1.prevIds).toEqual([])
    expect(snap2.prevIds).toEqual([snap1.id])
    expect(snap3.prevIds).toEqual([snap2.id])

    expect(snap3.ddl).toEqual(snap2.ddl)

    const manualSql = await readFile(join(testDir, entry2, "migration.sql"), "utf-8")
    expect(manualSql).toContain("UPDATE")
    expect(manualSql).not.toContain("ALTER TABLE")

    await rm(testDir, { recursive: true })
  })

  test("safe flow: multiple manual slots spliced in order", async () => {
    const testDir = join(tmpdir(), `drizzle-rebase-multi-manual-${Date.now()}`)
    await mkdir(testDir, { recursive: true })

    const theirSnap = makeSnapshot("their-1", [], TABLE_DDL)
    const theirDir = join(testDir, "20250101000000_initial")
    await mkdir(theirDir, { recursive: true })
    await writeFile(join(theirDir, "migration.sql"), 'CREATE TABLE "users" ("id" uuid);')
    await writeFile(join(theirDir, "snapshot.json"), JSON.stringify(theirSnap, null, 2))

    const myGenSnap = makeSnapshot("my-gen-1", ["their-1"], TABLE_WITH_EMAIL_DDL)
    const myManual1Snap = makeSnapshot("my-m1", ["my-gen-1"], TABLE_WITH_EMAIL_DDL)
    const myManual2Snap = makeSnapshot("my-m2", ["my-m1"], TABLE_WITH_EMAIL_DDL)

    const myMigrations: ClassifiedMigration[] = [
      {
        dirName: "20250102000000_add_email",
        dirPath: join(testDir, "20250102000000_add_email"),
        sql: 'ALTER TABLE "users" ADD COLUMN "email" text;',
        snapshot: myGenSnap,
        timestamp: "20250102000000",
        name: "add_email",
        classification: "generated",
        manualStatements: [],
      },
      {
        dirName: "20250103000000_backfill",
        dirPath: join(testDir, "20250103000000_backfill"),
        sql: 'UPDATE "users" SET "email" = \'x\';',
        snapshot: myManual1Snap,
        timestamp: "20250103000000",
        name: "backfill",
        classification: "manual",
        manualStatements: ['UPDATE "users" SET "email" = \'x\';'],
      },
      {
        dirName: "20250104000000_grant_access",
        dirPath: join(testDir, "20250104000000_grant_access"),
        sql: 'GRANT SELECT ON "users" TO app_role;',
        snapshot: myManual2Snap,
        timestamp: "20250104000000",
        name: "grant_access",
        classification: "manual",
        manualStatements: ['GRANT SELECT ON "users" TO app_role;'],
      },
    ]

    for (const m of myMigrations) {
      await mkdir(m.dirPath, { recursive: true })
      await writeFile(join(m.dirPath, "migration.sql"), m.sql)
      await writeFile(join(m.dirPath, "snapshot.json"), JSON.stringify(m.snapshot, null, 2))
    }

    expect(validateSlotOrdering(myMigrations).safe).toBe(true)

    const slots = extractManualSlots(myMigrations)
    expect(slots).toHaveLength(2)

    await deleteMigrationDirs(myMigrations)

    const regenSnap = makeSnapshot("regen-1", ["their-1"], TABLE_WITH_EMAIL_DDL)
    const regenDir = join(testDir, "20250110000000_add_email")
    await mkdir(regenDir, { recursive: true })
    await writeFile(join(regenDir, "migration.sql"), 'ALTER TABLE "users" ADD COLUMN "email" text;')
    await writeFile(join(regenDir, "snapshot.json"), JSON.stringify(regenSnap, null, 2))

    let prevSnapshot = regenSnap
    let currentTimestamp = "20250110000000"

    for (const slot of slots) {
      const snapshot = buildSnapshotForManualDir(prevSnapshot)
      const sqlContent = slot.sql.join("\n\n") + "\n"
      const safeName = slot.originalDirName.replace(/^\d{14}_/, "")

      const created = await createMigrationDir({
        migrationsDir: testDir,
        name: safeName,
        sql: sqlContent,
        snapshot,
        afterTimestamp: currentTimestamp,
      })

      prevSnapshot = snapshot
      currentTimestamp = created.timestamp
    }

    await repairSnapshotChain(testDir, "20250101000000")

    const finalEntries = (await readdir(testDir)).filter((e) => /^\d{14}_/.test(e)).sort()
    expect(finalEntries).toHaveLength(4)
    expect(finalEntries[0]).toBe("20250101000000_initial")
    expect(finalEntries[1]).toBe("20250110000000_add_email")
    expect(finalEntries[2]).toBe("20250110000001_backfill")
    expect(finalEntries[3]).toBe("20250110000002_grant_access")

    for (let i = 1; i < finalEntries.length; i++) {
      const prevEntry = finalEntries[i - 1]
      const currEntry = finalEntries[i]
      if (!prevEntry || !currEntry) continue
      const prevSnap = JSON.parse(
        await readFile(join(testDir, prevEntry, "snapshot.json"), "utf-8"),
      ) as Snapshot
      const currSnap = JSON.parse(
        await readFile(join(testDir, currEntry, "snapshot.json"), "utf-8"),
      ) as Snapshot
      expect(currSnap.prevIds).toEqual([prevSnap.id])
    }

    const backfillEntry = finalEntries[2]
    const grantEntry = finalEntries[3]
    if (!backfillEntry || !grantEntry) throw new Error("Expected 4 entries")

    const backfillSql = await readFile(join(testDir, backfillEntry, "migration.sql"), "utf-8")
    expect(backfillSql).toContain("UPDATE")

    const grantSql = await readFile(join(testDir, grantEntry, "migration.sql"), "utf-8")
    expect(grantSql).toContain("GRANT")

    await rm(testDir, { recursive: true })
  })

  test("no manual slots: generated-only rebase is clean", async () => {
    const testDir = join(tmpdir(), `drizzle-rebase-gen-only-${Date.now()}`)
    await mkdir(testDir, { recursive: true })

    const theirSnap = makeSnapshot("their-1", [], TABLE_DDL)
    const theirDir = join(testDir, "20250101000000_initial")
    await mkdir(theirDir, { recursive: true })
    await writeFile(join(theirDir, "migration.sql"), 'CREATE TABLE "users" ("id" uuid);')
    await writeFile(join(theirDir, "snapshot.json"), JSON.stringify(theirSnap, null, 2))

    const myGenSnap = makeSnapshot("my-gen-1", ["their-1"], TABLE_WITH_EMAIL_DDL)

    const myMigrations: ClassifiedMigration[] = [
      {
        dirName: "20250102000000_add_email",
        dirPath: join(testDir, "20250102000000_add_email"),
        sql: 'ALTER TABLE "users" ADD COLUMN "email" text;',
        snapshot: myGenSnap,
        timestamp: "20250102000000",
        name: "add_email",
        classification: "generated",
        manualStatements: [],
      },
    ]

    for (const m of myMigrations) {
      await mkdir(m.dirPath, { recursive: true })
      await writeFile(join(m.dirPath, "migration.sql"), m.sql)
      await writeFile(join(m.dirPath, "snapshot.json"), JSON.stringify(m.snapshot, null, 2))
    }

    const slots = extractManualSlots(myMigrations)
    expect(slots).toHaveLength(0)

    await deleteMigrationDirs(myMigrations)

    const afterDelete = (await readdir(testDir)).filter((e) => /^\d{14}_/.test(e))
    expect(afterDelete).toHaveLength(1)
    expect(afterDelete[0]).toBe("20250101000000_initial")

    await rm(testDir, { recursive: true })
  })
})
