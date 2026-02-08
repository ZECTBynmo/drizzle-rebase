import { drizzlePush } from "../drizzle"
import { backupMigrations, cleanupBackup, deleteMigrationDirs, restoreMigrations } from "../migration/backup"
import { createMigrationDir } from "../migration/create"
import { applyDiff, diffSnapshots, repairSnapshotChain } from "../snapshot"
import type { SnapshotConflict } from "../snapshot"
import type { RebaseResult } from "../types"
import type { RebasePlan } from "./rebase"

interface ExecuteRebaseOptions {
  migrationsDir: string
  cwd: string
  plan: RebasePlan
  push?: boolean
}

export async function executeRebase({
  migrationsDir,
  cwd,
  plan,
  push,
}: ExecuteRebaseOptions): Promise<RebaseResult> {
  // 1. Collect my migrations sorted by timestamp
  const myMigrations = [...plan.mine].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  )

  if (myMigrations.length === 0) {
    return { deleted: [], rebased: [], success: true }
  }

  // 2. Find the original base snapshot for the first "my" migration
  const firstMigration = myMigrations[0]!
  let firstMigrationBase = null
  const basePrevId = firstMigration.snapshot.prevIds[0]
  if (basePrevId) {
    const baseKept = plan.kept.find((m) => m.snapshot.id === basePrevId)
    if (baseKept) {
      firstMigrationBase = baseKept.snapshot
    }
  }
  if (!firstMigrationBase) {
    const keptBefore = plan.kept
      .filter((m) => m.timestamp < firstMigration.timestamp)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    if (keptBefore[0]) {
      firstMigrationBase = keptBefore[0].snapshot
    }
  }

  // 3. Compute incremental diffs for each of my migrations
  const diffs = myMigrations.map((migration, i) => {
    const prevSnapshot = i === 0 ? firstMigrationBase : myMigrations[i - 1]!.snapshot
    return diffSnapshots(prevSnapshot, migration.snapshot)
  })

  // 4. Backup my migrations
  const handle = await backupMigrations(migrationsDir, myMigrations)
  console.log(`Backup saved to: ${handle.backupDir}`)

  // 5. Apply diffs sequentially onto "their" final snapshot
  const lastKept = plan.kept[plan.kept.length - 1]
  let runningSnapshot = lastKept?.snapshot ?? null
  const allConflicts: SnapshotConflict[] = []
  const rebasedSnapshots = []

  for (let i = 0; i < myMigrations.length; i++) {
    const diff = diffs[i]!
    const prevId = runningSnapshot?.id ?? ""
    const result = applyDiff(runningSnapshot, diff, prevId)

    allConflicts.push(...result.conflicts)
    runningSnapshot = result.snapshot
    rebasedSnapshots.push(result.snapshot)
  }

  // 6. If conflicts → cleanup backup, report conflicts, fail
  // (originals haven't been deleted yet, so no restore needed)
  if (allConflicts.length > 0) {
    await cleanupBackup(handle)

    const conflictLines = allConflicts.map(
      (c) => `  - ${c.type}: ${c.entityKey}`,
    )
    return {
      deleted: [],
      rebased: [],
      success: false,
      error:
        `Snapshot conflicts detected during rebase:\n${conflictLines.join("\n")}\n\n` +
        `Both branches modified the same entities. Resolve conflicts manually.`,
    }
  }

  // 7. Delete old migration directories
  try {
    await deleteMigrationDirs(myMigrations)
  } catch (err) {
    await restoreMigrations(migrationsDir, handle)
    await cleanupBackup(handle)
    return {
      deleted: [],
      rebased: [],
      success: false,
      error: `Failed to delete migrations: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // 8. Create new directories with new timestamps, original SQL, rebased snapshots
  const deleted = myMigrations.map((m) => m.dirName)
  const rebasedDirNames: string[] = []
  const lastKeptTimestamp = lastKept?.timestamp ?? "00000000000000"
  let currentTimestamp = lastKeptTimestamp

  try {
    for (let i = 0; i < myMigrations.length; i++) {
      const migration = myMigrations[i]!
      const snapshot = rebasedSnapshots[i]!

      const created = await createMigrationDir({
        migrationsDir,
        name: migration.name,
        sql: migration.sql,
        snapshot,
        afterTimestamp: currentTimestamp,
      })

      rebasedDirNames.push(created.dirName)
      currentTimestamp = created.timestamp
    }

    // 9. Repair prevIds chain
    const repairStart = lastKept ? lastKept.timestamp : ""
    await repairSnapshotChain(migrationsDir, repairStart)
  } catch (err) {
    // Rollback: delete any newly created dirs and restore backup
    const { rm } = await import("node:fs/promises")
    const { join } = await import("node:path")
    for (const dirName of rebasedDirNames) {
      await rm(join(migrationsDir, dirName), { recursive: true, force: true })
    }
    await restoreMigrations(migrationsDir, handle)
    await cleanupBackup(handle)
    return {
      deleted: [],
      rebased: [],
      success: false,
      error: `Failed to create rebased migrations: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // 10. Cleanup backup
  await cleanupBackup(handle)

  // 11. Optionally push
  if (push) {
    const pushResult = await drizzlePush({ cwd })
    if (!pushResult.success) {
      console.error(`Warning: drizzle-kit push failed:\n${pushResult.output}`)
      console.error("Migrations were rebased successfully. Run 'drizzle-kit push' manually.")
    }
  }

  return {
    deleted,
    rebased: rebasedDirNames,
    success: true,
  }
}

export function formatRebaseResult(result: RebaseResult): string {
  const lines: string[] = []

  if (!result.success) {
    lines.push(`Rebase failed: ${result.error}`)
    return lines.join("\n")
  }

  if (result.deleted.length > 0) {
    lines.push("Deleted migrations:")
    for (const d of result.deleted) {
      lines.push(`  - ${d}`)
    }
  }

  if (result.rebased.length > 0) {
    lines.push("Rebased migrations:")
    for (const r of result.rebased) {
      lines.push(`  + ${r}`)
    }
  }

  if (result.deleted.length === 0 && result.rebased.length === 0) {
    lines.push("Nothing to do.")
  } else {
    lines.push("")
    lines.push("Rebase complete.")
  }

  return lines.join("\n")
}
