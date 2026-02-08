import { describe, expect, test } from "bun:test"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { executeRebase, formatRebaseResult } from "./run"
import { formatRebasePlan } from "./rebase"
import { backupMigrations, deleteMigrationDirs } from "../migration/backup"
import { createMigrationDir } from "../migration/create"
import { applyDiff, diffSnapshots, repairSnapshotChain } from "../snapshot"
import type { Migration, RebaseResult, Snapshot } from "../types"
import type { RebasePlan } from "./rebase"

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
  test("formats success with rebased migrations", () => {
    const result: RebaseResult = {
      deleted: ["20250101000000_add_email", "20250102000000_backfill"],
      rebased: ["20250103000000_add_email", "20250103000001_backfill"],
      success: true,
    }
    const output = formatRebaseResult(result)
    expect(output).toContain("Deleted migrations:")
    expect(output).toContain("  - 20250101000000_add_email")
    expect(output).toContain("Rebased migrations:")
    expect(output).toContain("  + 20250103000000_add_email")
    expect(output).toContain("Rebase complete.")
  })

  test("formats failure", () => {
    const result: RebaseResult = {
      deleted: [],
      rebased: [],
      success: false,
      error: "something broke",
    }
    const output = formatRebaseResult(result)
    expect(output).toContain("Rebase failed: something broke")
  })

  test("formats nothing to do", () => {
    const result: RebaseResult = {
      deleted: [],
      rebased: [],
      success: true,
    }
    const output = formatRebaseResult(result)
    expect(output).toContain("Nothing to do.")
  })

  test("formats rebased-only result", () => {
    const result: RebaseResult = {
      deleted: ["20250101000000_old"],
      rebased: ["20250102000000_new"],
      success: true,
    }
    const output = formatRebaseResult(result)
    expect(output).toContain("Deleted migrations:")
    expect(output).toContain("Rebased migrations:")
    expect(output).toContain("Rebase complete.")
  })
})

describe("formatRebasePlan steps", () => {
  test("steps description mentions snapshot rebase", () => {
    const plan: RebasePlan = {
      mine: [
        {
          dirName: "20250102000000_add_email",
          dirPath: "/tmp/20250102000000_add_email",
          sql: 'ALTER TABLE "users" ADD COLUMN "email" text;',
          snapshot: { version: "8", dialect: "postgres", id: "x", prevIds: [], ddl: [], renames: [] },
          timestamp: "20250102000000",
          name: "add_email",
        },
      ],
      kept: [],
    }
    const output = formatRebasePlan(plan)
    expect(output).toContain("rebase snapshots")
    expect(output).not.toContain("push")
    expect(output).not.toContain("splice")
    expect(output).not.toContain("drizzle-kit generate")
  })

  test("steps with manual SQL does not mention push or splice", () => {
    const plan: RebasePlan = {
      mine: [
        {
          dirName: "20250102000000_add_email",
          dirPath: "/tmp/20250102000000_add_email",
          sql: 'ALTER TABLE "users" ADD COLUMN "email" text;',
          snapshot: { version: "8", dialect: "postgres", id: "x", prevIds: [], ddl: [], renames: [] },
          timestamp: "20250102000000",
          name: "add_email",
        },
        {
          dirName: "20250103000000_backfill",
          dirPath: "/tmp/20250103000000_backfill",
          sql: "UPDATE users SET email = 'x';",
          snapshot: { version: "8", dialect: "postgres", id: "y", prevIds: ["x"], ddl: [], renames: [] },
          timestamp: "20250103000000",
          name: "backfill",
        },
      ],
      kept: [],
    }
    const output = formatRebasePlan(plan)
    expect(output).not.toContain("push")
    expect(output).not.toContain("splice")
    expect(output).toContain("rebase snapshots")
  })
})

describe("snapshot rebase integration", () => {
  test("basic rebase: their migration + my migration → snapshots merged", async () => {
    const testDir = join(tmpdir(), `drizzle-rebase-basic-${Date.now()}`)
    await mkdir(testDir, { recursive: true })

    // Their migration: creates users table
    const theirSnap = makeSnapshot("their-1", [], TABLE_DDL)
    const theirDir = join(testDir, "20250101000000_initial")
    await mkdir(theirDir, { recursive: true })
    await writeFile(join(theirDir, "migration.sql"), 'CREATE TABLE "users" ("id" uuid);')
    await writeFile(join(theirDir, "snapshot.json"), JSON.stringify(theirSnap, null, 2))

    // My migration: adds email column (originally based on no previous migration)
    const mySnap = makeSnapshot("my-1", [], TABLE_WITH_EMAIL_DDL)
    const myDir = join(testDir, "20250102000000_add_email")
    await mkdir(myDir, { recursive: true })
    await writeFile(join(myDir, "migration.sql"), 'ALTER TABLE "users" ADD COLUMN "email" text;')
    await writeFile(join(myDir, "snapshot.json"), JSON.stringify(mySnap, null, 2))

    // Compute the diff of my migration (from null → mySnap)
    const diff = diffSnapshots(null, mySnap)

    // Apply onto their snapshot
    const result = applyDiff(theirSnap, diff, theirSnap.id)

    expect(result.conflicts).toHaveLength(0)
    // Should have all of their entities + my new email column
    const names = result.snapshot.ddl.map((e) => e.name)
    expect(names).toContain("users")
    expect(names).toContain("id")
    expect(names).toContain("email")
    expect(result.snapshot.prevIds).toEqual([theirSnap.id])

    await rm(testDir, { recursive: true })
  })

  test("multiple my migrations → incremental diffs applied in order", async () => {
    const testDir = join(tmpdir(), `drizzle-rebase-multi-${Date.now()}`)
    await mkdir(testDir, { recursive: true })

    // Their migration
    const theirSnap = makeSnapshot("their-1", [], TABLE_DDL)
    const theirDir = join(testDir, "20250101000000_initial")
    await mkdir(theirDir, { recursive: true })
    await writeFile(join(theirDir, "migration.sql"), 'CREATE TABLE "users" ("id" uuid);')
    await writeFile(join(theirDir, "snapshot.json"), JSON.stringify(theirSnap, null, 2))

    // My migration 1: add email
    const mySnap1 = makeSnapshot("my-1", ["their-1"], TABLE_WITH_EMAIL_DDL)
    // My migration 2: make email NOT NULL
    const mySnap2 = makeSnapshot("my-2", ["my-1"], TABLE_WITH_EMAIL_NOTNULL_DDL)

    // Compute incremental diffs
    const diff1 = diffSnapshots(theirSnap, mySnap1)
    const diff2 = diffSnapshots(mySnap1, mySnap2)

    // Apply sequentially onto their final snapshot
    const result1 = applyDiff(theirSnap, diff1, theirSnap.id)
    expect(result1.conflicts).toHaveLength(0)

    const result2 = applyDiff(result1.snapshot, diff2, result1.snapshot.id)
    expect(result2.conflicts).toHaveLength(0)

    // Final snapshot should have email NOT NULL
    const emailCol = result2.snapshot.ddl.find(
      (e) => e.entityType === "columns" && e.name === "email",
    )
    expect(emailCol).toBeDefined()
    if (emailCol?.entityType === "columns") {
      expect(emailCol.notNull).toBe(true)
    }

    await rm(testDir, { recursive: true })
  })

  test("manual (empty-diff) migration → snapshot copies previous", async () => {
    const testDir = join(tmpdir(), `drizzle-rebase-manual-${Date.now()}`)
    await mkdir(testDir, { recursive: true })

    const theirSnap = makeSnapshot("their-1", [], TABLE_WITH_EMAIL_DDL)
    const theirDir = join(testDir, "20250101000000_initial")
    await mkdir(theirDir, { recursive: true })
    await writeFile(join(theirDir, "migration.sql"), 'CREATE TABLE "users" (...);')
    await writeFile(join(theirDir, "snapshot.json"), JSON.stringify(theirSnap, null, 2))

    // My manual migration: same DDL as previous
    const mySnap = makeSnapshot("my-1", ["their-1"], TABLE_WITH_EMAIL_DDL)
    const diff = diffSnapshots(theirSnap, mySnap)

    // Empty diff
    expect(diff.added).toHaveLength(0)
    expect(diff.removed).toHaveLength(0)
    expect(diff.modified).toHaveLength(0)

    const result = applyDiff(theirSnap, diff, theirSnap.id)

    expect(result.conflicts).toHaveLength(0)
    expect(result.snapshot.ddl).toEqual(theirSnap.ddl)

    await rm(testDir, { recursive: true })
  })

  test("mixed migration → snapshot captures schema change, SQL preserved", async () => {
    const testDir = join(tmpdir(), `drizzle-rebase-mixed-${Date.now()}`)
    await mkdir(testDir, { recursive: true })

    const theirSnap = makeSnapshot("their-1", [], TABLE_WITH_EMAIL_DDL)

    // My mixed migration: makes email NOT NULL (DDL change + DML backfill)
    const mySnap = makeSnapshot("my-1", ["their-1"], TABLE_WITH_EMAIL_NOTNULL_DDL)
    const originalSql =
      'UPDATE "users" SET "email" = \'unknown\' WHERE "email" IS NULL;\nALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL;'

    const diff = diffSnapshots(theirSnap, mySnap)
    const result = applyDiff(theirSnap, diff, theirSnap.id)

    expect(result.conflicts).toHaveLength(0)

    // Create the rebased migration dir
    const created = await createMigrationDir({
      migrationsDir: testDir,
      name: "mixed_ddl_dml",
      sql: originalSql,
      snapshot: result.snapshot,
      afterTimestamp: "20250101000000",
    })

    // SQL should be preserved exactly
    const writtenSql = await readFile(join(created.dirPath, "migration.sql"), "utf-8")
    expect(writtenSql).toBe(originalSql)

    // Snapshot should have the schema change
    const writtenSnap = JSON.parse(
      await readFile(join(created.dirPath, "snapshot.json"), "utf-8"),
    ) as Snapshot
    const emailCol = writtenSnap.ddl.find(
      (e) => e.entityType === "columns" && e.name === "email",
    )
    if (emailCol?.entityType === "columns") {
      expect(emailCol.notNull).toBe(true)
    }

    await rm(testDir, { recursive: true })
  })

  test("conflict detection: both add same entity differently → error", () => {
    const theirSnap = makeSnapshot("their-1", [], [
      ...TABLE_DDL,
      {
        entityType: "columns",
        name: "email",
        schema: "public",
        table: "users",
        type: "varchar",
        typeSchema: null,
        notNull: true,
        dimensions: 0,
        default: null,
        generated: null,
        identity: null,
      },
    ])

    // My migration also adds email but as text, not varchar
    const mySnap = makeSnapshot("my-1", [], TABLE_WITH_EMAIL_DDL)
    const diff = diffSnapshots(null, mySnap)

    const result = applyDiff(theirSnap, diff, theirSnap.id)

    // Conflict on email column: I add it as text, they have it as varchar
    expect(result.conflicts.length).toBeGreaterThan(0)
    const emailConflict = result.conflicts.find((c) => c.entityKey.includes("email"))
    expect(emailConflict).toBeDefined()
    expect(emailConflict?.type).toBe("add-exists")
  })

  test("full rebase flow: backup, delete, create rebased dirs, repair chain", async () => {
    const testDir = join(tmpdir(), `drizzle-rebase-full-flow-${Date.now()}`)
    await mkdir(testDir, { recursive: true })

    // Their migration
    const theirSnap = makeSnapshot("their-1", [], TABLE_DDL)
    const theirDir = join(testDir, "20250101000000_initial")
    await mkdir(theirDir, { recursive: true })
    await writeFile(join(theirDir, "migration.sql"), 'CREATE TABLE "users" ("id" uuid);')
    await writeFile(join(theirDir, "snapshot.json"), JSON.stringify(theirSnap, null, 2))

    // My migrations
    const myGenSnap = makeSnapshot("my-gen-1", ["their-1"], TABLE_WITH_EMAIL_DDL)
    const myManualSnap = makeSnapshot("my-manual-1", ["my-gen-1"], TABLE_WITH_EMAIL_DDL)

    const myMigrations: Migration[] = [
      {
        dirName: "20250102000000_add_email",
        dirPath: join(testDir, "20250102000000_add_email"),
        sql: 'ALTER TABLE "users" ADD COLUMN "email" text;',
        snapshot: myGenSnap,
        timestamp: "20250102000000",
        name: "add_email",
      },
      {
        dirName: "20250103000000_backfill_emails",
        dirPath: join(testDir, "20250103000000_backfill_emails"),
        sql: 'UPDATE "users" SET "email" = \'test@test.com\' WHERE "email" IS NULL;',
        snapshot: myManualSnap,
        timestamp: "20250103000000",
        name: "backfill_emails",
      },
    ]

    for (const m of myMigrations) {
      await mkdir(m.dirPath, { recursive: true })
      await writeFile(join(m.dirPath, "migration.sql"), m.sql)
      await writeFile(join(m.dirPath, "snapshot.json"), JSON.stringify(m.snapshot, null, 2))
    }

    // Compute incremental diffs
    const diff1 = diffSnapshots(theirSnap, myGenSnap)
    const diff2 = diffSnapshots(myGenSnap, myManualSnap)

    // Backup and delete
    await backupMigrations(testDir, myMigrations)
    await deleteMigrationDirs(myMigrations)

    const afterDelete = await readdir(testDir)
    expect(afterDelete.filter((e) => /^\d{14}_/.test(e))).toHaveLength(1)

    // Apply diffs sequentially
    let runningSnap = theirSnap
    const rebasedSnapshots = []

    const result1 = applyDiff(runningSnap, diff1, runningSnap.id)
    expect(result1.conflicts).toHaveLength(0)
    runningSnap = result1.snapshot
    rebasedSnapshots.push(result1.snapshot)

    const result2 = applyDiff(runningSnap, diff2, runningSnap.id)
    expect(result2.conflicts).toHaveLength(0)
    rebasedSnapshots.push(result2.snapshot)

    // Create rebased dirs
    let currentTimestamp = "20250101000000"
    for (let i = 0; i < myMigrations.length; i++) {
      const m = myMigrations[i]!
      await createMigrationDir({
        migrationsDir: testDir,
        name: m.name,
        sql: m.sql,
        snapshot: rebasedSnapshots[i]!,
        afterTimestamp: currentTimestamp,
      })
      currentTimestamp = String(BigInt(currentTimestamp) + 1n)
    }

    await repairSnapshotChain(testDir, "20250101000000")

    const finalEntries = (await readdir(testDir))
      .filter((e) => /^\d{14}_/.test(e))
      .sort()
    expect(finalEntries).toHaveLength(3)
    expect(finalEntries[0]).toBe("20250101000000_initial")

    // Verify chain
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

    // Verify SQL preserved
    const lastEntry = finalEntries[finalEntries.length - 1]!
    const backfillSql = await readFile(join(testDir, lastEntry, "migration.sql"), "utf-8")
    expect(backfillSql).toContain("UPDATE")

    await rm(testDir, { recursive: true })
  })

  test("generated-only rebase: snapshots rebased correctly", async () => {
    const testDir = join(tmpdir(), `drizzle-rebase-gen-only-${Date.now()}`)
    await mkdir(testDir, { recursive: true })

    const theirSnap = makeSnapshot("their-1", [], TABLE_DDL)
    const theirDir = join(testDir, "20250101000000_initial")
    await mkdir(theirDir, { recursive: true })
    await writeFile(join(theirDir, "migration.sql"), 'CREATE TABLE "users" ("id" uuid);')
    await writeFile(join(theirDir, "snapshot.json"), JSON.stringify(theirSnap, null, 2))

    const myGenSnap = makeSnapshot("my-gen-1", ["their-1"], TABLE_WITH_EMAIL_DDL)

    const myMigrations: Migration[] = [
      {
        dirName: "20250102000000_add_email",
        dirPath: join(testDir, "20250102000000_add_email"),
        sql: 'ALTER TABLE "users" ADD COLUMN "email" text;',
        snapshot: myGenSnap,
        timestamp: "20250102000000",
        name: "add_email",
      },
    ]

    for (const m of myMigrations) {
      await mkdir(m.dirPath, { recursive: true })
      await writeFile(join(m.dirPath, "migration.sql"), m.sql)
      await writeFile(join(m.dirPath, "snapshot.json"), JSON.stringify(m.snapshot, null, 2))
    }

    await deleteMigrationDirs(myMigrations)

    const diff = diffSnapshots(theirSnap, myGenSnap)
    const result = applyDiff(theirSnap, diff, theirSnap.id)
    expect(result.conflicts).toHaveLength(0)

    await createMigrationDir({
      migrationsDir: testDir,
      name: "add_email",
      sql: 'ALTER TABLE "users" ADD COLUMN "email" text;',
      snapshot: result.snapshot,
      afterTimestamp: "20250101000000",
    })

    await repairSnapshotChain(testDir, "20250101000000")

    const finalEntries = (await readdir(testDir)).filter((e) => /^\d{14}_/.test(e)).sort()
    expect(finalEntries).toHaveLength(2)
    expect(finalEntries[0]).toBe("20250101000000_initial")

    const rebasedSnap = JSON.parse(
      await readFile(join(testDir, finalEntries[1]!, "snapshot.json"), "utf-8"),
    ) as Snapshot
    const theirSnapFinal = JSON.parse(
      await readFile(join(testDir, finalEntries[0]!, "snapshot.json"), "utf-8"),
    ) as Snapshot
    expect(rebasedSnap.prevIds).toEqual([theirSnapFinal.id])

    // Verify the email column is in the rebased snapshot
    const emailCol = rebasedSnap.ddl.find(
      (e) => e.entityType === "columns" && e.name === "email",
    )
    expect(emailCol).toBeDefined()

    await rm(testDir, { recursive: true })
  })
})

describe("executeRebase end-to-end", () => {
  test("single migration rebase: SQL preserved, snapshot rebased, timestamps reordered", async () => {
    const testDir = join(tmpdir(), `drizzle-rebase-e2e-single-${Date.now()}`)
    await mkdir(testDir, { recursive: true })

    // Their migration on disk
    const theirSnap = makeSnapshot("their-1", [], TABLE_DDL)
    const theirDir = join(testDir, "20250101000000_initial")
    await mkdir(theirDir, { recursive: true })
    await writeFile(join(theirDir, "migration.sql"), 'CREATE TABLE "users" ("id" uuid);')
    await writeFile(join(theirDir, "snapshot.json"), JSON.stringify(theirSnap, null, 2))

    // My migration on disk
    const mySnap = makeSnapshot("my-1", ["their-1"], TABLE_WITH_EMAIL_DDL)
    const myDirName = "20250102000000_add_email"
    const myDir = join(testDir, myDirName)
    await mkdir(myDir, { recursive: true })
    const originalSql = 'ALTER TABLE "users" ADD COLUMN "email" text;'
    await writeFile(join(myDir, "migration.sql"), originalSql)
    await writeFile(join(myDir, "snapshot.json"), JSON.stringify(mySnap, null, 2))

    const kept: Migration[] = [
      {
        dirName: "20250101000000_initial",
        dirPath: theirDir,
        sql: 'CREATE TABLE "users" ("id" uuid);',
        snapshot: theirSnap,
        timestamp: "20250101000000",
        name: "initial",
      },
    ]

    const mine: Migration[] = [
      {
        dirName: myDirName,
        dirPath: myDir,
        sql: originalSql,
        snapshot: mySnap,
        timestamp: "20250102000000",
        name: "add_email",
      },
    ]

    const plan: RebasePlan = { mine, kept }

    const result = await executeRebase({ migrationsDir: testDir, cwd: testDir, plan })

    expect(result.success).toBe(true)
    expect(result.deleted).toEqual([myDirName])
    expect(result.rebased).toHaveLength(1)

    // Old dir should not exist
    const entries = (await readdir(testDir)).filter((e) => /^\d{14}_/.test(e)).sort()
    expect(entries).toHaveLength(2)
    expect(entries).not.toContain(myDirName)

    // New dir should have timestamp > their timestamp
    const newDirName = result.rebased[0]!
    expect(newDirName > "20250101000000_initial").toBe(true)

    // SQL should be preserved exactly
    const writtenSql = await readFile(join(testDir, newDirName, "migration.sql"), "utf-8")
    expect(writtenSql).toBe(originalSql)

    // Snapshot should have all entities (users table + id + email)
    const writtenSnap = JSON.parse(
      await readFile(join(testDir, newDirName, "snapshot.json"), "utf-8"),
    ) as Snapshot
    const entityNames = writtenSnap.ddl.map((e) => e.name)
    expect(entityNames).toContain("users")
    expect(entityNames).toContain("id")
    expect(entityNames).toContain("email")

    // prevIds chain should link to their snapshot
    expect(writtenSnap.prevIds).toEqual([theirSnap.id])

    await rm(testDir, { recursive: true })
  })

  test("multi-migration rebase: incremental changes preserved", async () => {
    const testDir = join(tmpdir(), `drizzle-rebase-e2e-multi-${Date.now()}`)
    await mkdir(testDir, { recursive: true })

    // Their migration
    const theirSnap = makeSnapshot("their-1", [], TABLE_DDL)
    const theirDir = join(testDir, "20250101000000_initial")
    await mkdir(theirDir, { recursive: true })
    await writeFile(join(theirDir, "migration.sql"), 'CREATE TABLE "users" ("id" uuid);')
    await writeFile(join(theirDir, "snapshot.json"), JSON.stringify(theirSnap, null, 2))

    // My first migration: add email
    const mySnap1 = makeSnapshot("my-1", ["their-1"], TABLE_WITH_EMAIL_DDL)
    const myDir1Name = "20250102000000_add_email"
    const myDir1 = join(testDir, myDir1Name)
    await mkdir(myDir1, { recursive: true })
    const sql1 = 'ALTER TABLE "users" ADD COLUMN "email" text;'
    await writeFile(join(myDir1, "migration.sql"), sql1)
    await writeFile(join(myDir1, "snapshot.json"), JSON.stringify(mySnap1, null, 2))

    // My second migration: make email NOT NULL
    const mySnap2 = makeSnapshot("my-2", ["my-1"], TABLE_WITH_EMAIL_NOTNULL_DDL)
    const myDir2Name = "20250103000000_email_not_null"
    const myDir2 = join(testDir, myDir2Name)
    await mkdir(myDir2, { recursive: true })
    const sql2 = 'ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL;'
    await writeFile(join(myDir2, "migration.sql"), sql2)
    await writeFile(join(myDir2, "snapshot.json"), JSON.stringify(mySnap2, null, 2))

    const kept: Migration[] = [
      {
        dirName: "20250101000000_initial",
        dirPath: theirDir,
        sql: 'CREATE TABLE "users" ("id" uuid);',
        snapshot: theirSnap,
        timestamp: "20250101000000",
        name: "initial",
      },
    ]

    const plan: RebasePlan = {
      mine: [
        {
          dirName: myDir1Name,
          dirPath: myDir1,
          sql: sql1,
          snapshot: mySnap1,
          timestamp: "20250102000000",
          name: "add_email",
        },
        {
          dirName: myDir2Name,
          dirPath: myDir2,
          sql: sql2,
          snapshot: mySnap2,
          timestamp: "20250103000000",
          name: "email_not_null",
        },
      ],
      kept,
    }

    const result = await executeRebase({ migrationsDir: testDir, cwd: testDir, plan })

    expect(result.success).toBe(true)
    expect(result.deleted).toHaveLength(2)
    expect(result.rebased).toHaveLength(2)

    const entries = (await readdir(testDir)).filter((e) => /^\d{14}_/.test(e)).sort()
    expect(entries).toHaveLength(3)

    // Verify second rebased migration has email NOT NULL
    const lastEntry = entries[entries.length - 1]!
    const lastSnap = JSON.parse(
      await readFile(join(testDir, lastEntry, "snapshot.json"), "utf-8"),
    ) as Snapshot
    const emailCol = lastSnap.ddl.find(
      (e) => e.entityType === "columns" && e.name === "email",
    )
    expect(emailCol).toBeDefined()
    if (emailCol?.entityType === "columns") {
      expect(emailCol.notNull).toBe(true)
    }

    // Verify SQL preserved in both
    const sql1Written = await readFile(join(testDir, entries[1]!, "migration.sql"), "utf-8")
    expect(sql1Written).toBe(sql1)
    const sql2Written = await readFile(join(testDir, entries[2]!, "migration.sql"), "utf-8")
    expect(sql2Written).toBe(sql2)

    // Verify prevIds chain
    for (let i = 1; i < entries.length; i++) {
      const prevSnap = JSON.parse(
        await readFile(join(testDir, entries[i - 1]!, "snapshot.json"), "utf-8"),
      ) as Snapshot
      const currSnap = JSON.parse(
        await readFile(join(testDir, entries[i]!, "snapshot.json"), "utf-8"),
      ) as Snapshot
      expect(currSnap.prevIds).toEqual([prevSnap.id])
    }

    await rm(testDir, { recursive: true })
  })

  test("conflict detection: originals preserved, returns error", async () => {
    const testDir = join(tmpdir(), `drizzle-rebase-e2e-conflict-${Date.now()}`)
    await mkdir(testDir, { recursive: true })

    // Shared base: users table only
    const sharedSnap = makeSnapshot("shared-1", [], TABLE_DDL)
    const sharedDir = join(testDir, "20250100000000_base")
    await mkdir(sharedDir, { recursive: true })
    await writeFile(join(sharedDir, "migration.sql"), 'CREATE TABLE "users" ("id" uuid);')
    await writeFile(join(sharedDir, "snapshot.json"), JSON.stringify(sharedSnap, null, 2))

    // Their migration adds email as varchar NOT NULL (on top of shared base)
    const theirEmailDdl: Snapshot["ddl"] = [
      ...TABLE_DDL,
      {
        entityType: "columns",
        name: "email",
        schema: "public",
        table: "users",
        type: "varchar",
        typeSchema: null,
        notNull: true,
        dimensions: 0,
        default: null,
        generated: null,
        identity: null,
      },
    ]
    const theirSnap = makeSnapshot("their-1", ["shared-1"], theirEmailDdl)
    const theirDir = join(testDir, "20250101000000_add_email_theirs")
    await mkdir(theirDir, { recursive: true })
    await writeFile(join(theirDir, "migration.sql"), 'ALTER TABLE "users" ADD COLUMN "email" varchar NOT NULL;')
    await writeFile(join(theirDir, "snapshot.json"), JSON.stringify(theirSnap, null, 2))

    // My migration also adds email but as text nullable (based on shared base, not theirs)
    const mySnap = makeSnapshot("my-1", ["shared-1"], TABLE_WITH_EMAIL_DDL)
    const myDirName = "20250102000000_add_email"
    const myDir = join(testDir, myDirName)
    await mkdir(myDir, { recursive: true })
    const originalSql = 'ALTER TABLE "users" ADD COLUMN "email" text;'
    await writeFile(join(myDir, "migration.sql"), originalSql)
    await writeFile(join(myDir, "snapshot.json"), JSON.stringify(mySnap, null, 2))

    const kept: Migration[] = [
      {
        dirName: "20250100000000_base",
        dirPath: sharedDir,
        sql: 'CREATE TABLE "users" ("id" uuid);',
        snapshot: sharedSnap,
        timestamp: "20250100000000",
        name: "base",
      },
      {
        dirName: "20250101000000_add_email_theirs",
        dirPath: theirDir,
        sql: 'ALTER TABLE "users" ADD COLUMN "email" varchar NOT NULL;',
        snapshot: theirSnap,
        timestamp: "20250101000000",
        name: "add_email_theirs",
      },
    ]

    const plan: RebasePlan = {
      mine: [
        {
          dirName: myDirName,
          dirPath: myDir,
          sql: originalSql,
          snapshot: mySnap,
          timestamp: "20250102000000",
          name: "add_email",
        },
      ],
      kept,
    }

    const result = await executeRebase({ migrationsDir: testDir, cwd: testDir, plan })

    expect(result.success).toBe(false)
    expect(result.error).toContain("conflict")

    // Original directories should still exist
    const entries = (await readdir(testDir)).filter((e) => /^\d{14}_/.test(e)).sort()
    expect(entries).toContain("20250100000000_base")
    expect(entries).toContain("20250101000000_add_email_theirs")
    expect(entries).toContain(myDirName)

    // Original SQL should be intact
    const originalSqlStill = await readFile(join(myDir, "migration.sql"), "utf-8")
    expect(originalSqlStill).toBe(originalSql)

    await rm(testDir, { recursive: true })
  })

  test("no kept migrations: rebases from null base", async () => {
    const testDir = join(tmpdir(), `drizzle-rebase-e2e-nokept-${Date.now()}`)
    await mkdir(testDir, { recursive: true })

    // Only my migration, no kept ones
    const mySnap = makeSnapshot("my-1", [], TABLE_WITH_EMAIL_DDL)
    const myDirName = "20250102000000_add_email"
    const myDir = join(testDir, myDirName)
    await mkdir(myDir, { recursive: true })
    const originalSql = 'CREATE TABLE "users" ("id" uuid, "email" text);'
    await writeFile(join(myDir, "migration.sql"), originalSql)
    await writeFile(join(myDir, "snapshot.json"), JSON.stringify(mySnap, null, 2))

    const plan: RebasePlan = {
      mine: [
        {
          dirName: myDirName,
          dirPath: myDir,
          sql: originalSql,
          snapshot: mySnap,
          timestamp: "20250102000000",
          name: "add_email",
        },
      ],
      kept: [],
    }

    const result = await executeRebase({ migrationsDir: testDir, cwd: testDir, plan })

    expect(result.success).toBe(true)
    expect(result.deleted).toEqual([myDirName])
    expect(result.rebased).toHaveLength(1)

    // New dir should exist with timestamp "00000000000001"
    const entries = (await readdir(testDir)).filter((e) => /^\d{14}_/.test(e)).sort()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toBe("00000000000001_add_email")

    // SQL preserved
    const writtenSql = await readFile(join(testDir, entries[0]!, "migration.sql"), "utf-8")
    expect(writtenSql).toBe(originalSql)

    // Snapshot has all entities
    const writtenSnap = JSON.parse(
      await readFile(join(testDir, entries[0]!, "snapshot.json"), "utf-8"),
    ) as Snapshot
    expect(writtenSnap.ddl).toHaveLength(TABLE_WITH_EMAIL_DDL.length)

    await rm(testDir, { recursive: true })
  })

  test("divergent base: my migration based on shared ancestor, theirs added more", async () => {
    const testDir = join(tmpdir(), `drizzle-rebase-e2e-diverge-${Date.now()}`)
    await mkdir(testDir, { recursive: true })

    // Shared ancestor: users table
    const sharedSnap = makeSnapshot("shared-1", [], TABLE_DDL)
    const sharedDir = join(testDir, "20250101000000_initial")
    await mkdir(sharedDir, { recursive: true })
    await writeFile(join(sharedDir, "migration.sql"), 'CREATE TABLE "users" ("id" uuid);')
    await writeFile(join(sharedDir, "snapshot.json"), JSON.stringify(sharedSnap, null, 2))

    // Their migration: add orders table (on top of shared)
    const ordersTableDdl: Snapshot["ddl"] = [
      ...TABLE_DDL,
      { entityType: "tables", name: "orders", schema: "public", isRlsEnabled: false },
    ]
    const theirSnap = makeSnapshot("their-1", ["shared-1"], ordersTableDdl)
    const theirDir = join(testDir, "20250102000000_add_orders")
    await mkdir(theirDir, { recursive: true })
    await writeFile(join(theirDir, "migration.sql"), 'CREATE TABLE "orders" ();')
    await writeFile(join(theirDir, "snapshot.json"), JSON.stringify(theirSnap, null, 2))

    // My migration: add email column (based on shared, NOT on their orders migration)
    const mySnap = makeSnapshot("my-1", ["shared-1"], TABLE_WITH_EMAIL_DDL)
    const myDirName = "20250103000000_add_email"
    const myDir = join(testDir, myDirName)
    await mkdir(myDir, { recursive: true })
    const originalSql = 'ALTER TABLE "users" ADD COLUMN "email" text;'
    await writeFile(join(myDir, "migration.sql"), originalSql)
    await writeFile(join(myDir, "snapshot.json"), JSON.stringify(mySnap, null, 2))

    const kept: Migration[] = [
      {
        dirName: "20250101000000_initial",
        dirPath: sharedDir,
        sql: 'CREATE TABLE "users" ("id" uuid);',
        snapshot: sharedSnap,
        timestamp: "20250101000000",
        name: "initial",
      },
      {
        dirName: "20250102000000_add_orders",
        dirPath: theirDir,
        sql: 'CREATE TABLE "orders" ();',
        snapshot: theirSnap,
        timestamp: "20250102000000",
        name: "add_orders",
      },
    ]

    const plan: RebasePlan = {
      mine: [
        {
          dirName: myDirName,
          dirPath: myDir,
          sql: originalSql,
          snapshot: mySnap,
          timestamp: "20250103000000",
          name: "add_email",
        },
      ],
      kept,
    }

    const result = await executeRebase({ migrationsDir: testDir, cwd: testDir, plan })

    expect(result.success).toBe(true)
    expect(result.rebased).toHaveLength(1)

    // The rebased snapshot should have: users table + id + orders table + email
    const entries = (await readdir(testDir)).filter((e) => /^\d{14}_/.test(e)).sort()
    expect(entries).toHaveLength(3)

    const rebasedEntry = entries[entries.length - 1]!
    const rebasedSnap = JSON.parse(
      await readFile(join(testDir, rebasedEntry, "snapshot.json"), "utf-8"),
    ) as Snapshot
    const entityNames = rebasedSnap.ddl.map((e) => e.name)
    expect(entityNames).toContain("users")
    expect(entityNames).toContain("id")
    expect(entityNames).toContain("orders")
    expect(entityNames).toContain("email")

    // prevIds should chain to their last migration
    expect(rebasedSnap.prevIds).toEqual([theirSnap.id])

    // SQL preserved
    const writtenSql = await readFile(join(testDir, rebasedEntry, "migration.sql"), "utf-8")
    expect(writtenSql).toBe(originalSql)

    await rm(testDir, { recursive: true })
  })

  test("manual migration is also rebased", async () => {
    const testDir = join(tmpdir(), `drizzle-rebase-e2e-attention-${Date.now()}`)
    await mkdir(testDir, { recursive: true })

    // Their migration
    const theirSnap = makeSnapshot("their-1", [], TABLE_DDL)
    const theirDir = join(testDir, "20250101000000_initial")
    await mkdir(theirDir, { recursive: true })
    await writeFile(join(theirDir, "migration.sql"), 'CREATE TABLE "users" ("id" uuid);')
    await writeFile(join(theirDir, "snapshot.json"), JSON.stringify(theirSnap, null, 2))

    // My manual migration (same schema, DML only)
    const mySnap = makeSnapshot("my-1", ["their-1"], TABLE_DDL)
    const myDirName = "20250102000000_backfill"
    const myDir = join(testDir, myDirName)
    await mkdir(myDir, { recursive: true })
    const manualSql = "UPDATE \"users\" SET \"name\" = 'default' WHERE \"name\" IS NULL;"
    await writeFile(join(myDir, "migration.sql"), manualSql)
    await writeFile(join(myDir, "snapshot.json"), JSON.stringify(mySnap, null, 2))

    const kept: Migration[] = [
      {
        dirName: "20250101000000_initial",
        dirPath: theirDir,
        sql: 'CREATE TABLE "users" ("id" uuid);',
        snapshot: theirSnap,
        timestamp: "20250101000000",
        name: "initial",
      },
    ]

    const plan: RebasePlan = {
      mine: [
        {
          dirName: myDirName,
          dirPath: myDir,
          sql: manualSql,
          snapshot: mySnap,
          timestamp: "20250102000000",
          name: "backfill",
        },
      ],
      kept,
    }

    const result = await executeRebase({ migrationsDir: testDir, cwd: testDir, plan })

    expect(result.success).toBe(true)
    expect(result.rebased).toHaveLength(1)

    // SQL should be preserved exactly
    const entries = (await readdir(testDir)).filter((e) => /^\d{14}_/.test(e)).sort()
    const rebasedEntry = entries[entries.length - 1]!
    const writtenSql = await readFile(join(testDir, rebasedEntry, "migration.sql"), "utf-8")
    expect(writtenSql).toBe(manualSql)

    await rm(testDir, { recursive: true })
  })

  test("empty plan: returns nothing to do", async () => {
    const testDir = join(tmpdir(), `drizzle-rebase-e2e-empty-${Date.now()}`)
    await mkdir(testDir, { recursive: true })

    const plan: RebasePlan = { mine: [], kept: [] }
    const result = await executeRebase({ migrationsDir: testDir, cwd: testDir, plan })

    expect(result.success).toBe(true)
    expect(result.deleted).toHaveLength(0)
    expect(result.rebased).toHaveLength(0)

    await rm(testDir, { recursive: true })
  })
})
