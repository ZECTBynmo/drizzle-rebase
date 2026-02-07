import { readdir, rm } from "node:fs/promises"
import { drizzleGenerate, drizzlePush } from "../drizzle"
import { backupMigrations, deleteMigrationDirs, restoreMigrations } from "../migration/backup"
import { createMigrationDir } from "../migration/create"
import { extractManualSlots, validateSlotOrdering } from "../migration/extract"
import { buildSnapshotForManualDir, repairSnapshotChain } from "../snapshot/chain"
import { parseSnapshot } from "../snapshot/parse"
import { join } from "node:path"
import type { RebaseResult } from "../types"
import type { RebasePlan } from "./rebase"

interface ExecuteRebaseOptions {
  migrationsDir: string
  cwd: string
  plan: RebasePlan
}

export async function executeRebase({
  migrationsDir,
  cwd,
  plan,
}: ExecuteRebaseOptions): Promise<RebaseResult> {
  const myMigrations = [...plan.safeToDelete, ...plan.needsAttention].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  )

  if (myMigrations.length === 0) {
    return { deleted: [], generated: [], manualDirs: [], success: true }
  }

  const interleaveCheck = validateSlotOrdering(myMigrations)
  if (!interleaveCheck.safe && interleaveCheck.problemSlot) {
    const slot = interleaveCheck.problemSlot
    return {
      deleted: [],
      generated: [],
      manualDirs: [],
      success: false,
      error:
        `Cannot auto-rebase: manual migration "${slot.originalDirName}" is interleaved between generated migrations.\n` +
        `When drizzle-kit regenerates, it combines all DDL into one migration, so manual SQL\n` +
        `that depends on intermediate DDL steps cannot be correctly placed.\n\n` +
        `To fix: split your branch so manual migrations come after all generated ones, or\n` +
        `handle this migration manually.`,
    }
  }

  const lastKept = plan.kept[plan.kept.length - 1]
  const manualSlots = extractManualSlots(myMigrations)

  const backups = backupMigrations(myMigrations)

  try {
    await deleteMigrationDirs(myMigrations)
  } catch (err) {
    await restoreMigrations(backups)
    return {
      deleted: [],
      generated: [],
      manualDirs: [],
      success: false,
      error: `Failed to delete migrations: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const existingDirs = new Set((await readdir(migrationsDir)).filter((e) => /^\d{14}_/.test(e)))

  const genResult = await drizzleGenerate({ cwd, migrationsDir, existingDirs })
  if (!genResult.success) {
    const afterEntries = (await readdir(migrationsDir)).filter((e) => /^\d{14}_/.test(e))
    for (const entry of afterEntries) {
      if (!existingDirs.has(entry)) {
        await rm(join(migrationsDir, entry), { recursive: true, force: true })
      }
    }
    await restoreMigrations(backups)
    return {
      deleted: [],
      generated: [],
      manualDirs: [],
      success: false,
      error: `drizzle-kit generate failed:\n${genResult.output}`,
    }
  }

  const deleted = myMigrations.map((m) => m.dirName)
  const manualDirNames: string[] = []

  if (manualSlots.length > 0) {
    try {
      const allEntriesAfterGen = (await readdir(migrationsDir))
        .filter((e) => /^\d{14}_/.test(e))
        .sort()
      const lastEntry = allEntriesAfterGen[allEntriesAfterGen.length - 1]
      const lastTimestamp = lastEntry?.match(/^(\d{14})_/)?.[1]

      if (!lastEntry || !lastTimestamp) {
        throw new Error(
          "No migrations exist after generate. This can happen when all your migrations " +
            "are manual/mixed and there are no base migrations to anchor to. " +
            "Consider keeping at least one generated migration before manual ones.",
        )
      }

      const lastGenSnapshotPath = join(migrationsDir, lastEntry, "snapshot.json")
      let prevSnapshot = await parseSnapshot(lastGenSnapshotPath)
      let currentTimestamp = lastTimestamp

      for (const slot of manualSlots) {
        const snapshot = buildSnapshotForManualDir(prevSnapshot)
        const sqlContent = slot.sql.join("\n\n") + "\n"
        const safeName = slot.originalDirName.replace(/^\d{14}_/, "")

        const created = await createMigrationDir({
          migrationsDir,
          name: safeName,
          sql: sqlContent,
          snapshot,
          afterTimestamp: currentTimestamp,
        })

        manualDirNames.push(created.dirName)
        prevSnapshot = snapshot
        currentTimestamp = created.timestamp
      }

      const repairStart = lastKept
        ? lastKept.timestamp
        : genResult.newDirs[0]?.match(/^(\d{14})_/)?.[1]
      if (repairStart) {
        await repairSnapshotChain(migrationsDir, repairStart)
      }
    } catch (err) {
      for (const dirName of [...genResult.newDirs, ...manualDirNames]) {
        await rm(join(migrationsDir, dirName), { recursive: true, force: true })
      }
      await restoreMigrations(backups)
      return {
        deleted: [],
        generated: [],
        manualDirs: [],
        success: false,
        error: `Failed to splice manual SQL: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  const pushResult = await drizzlePush({ cwd })
  if (!pushResult.success) {
    console.error(`Warning: drizzle-kit push failed:\n${pushResult.output}`)
    console.error("Migrations were generated successfully. Run 'drizzle-kit push' manually.")
  }

  return {
    deleted,
    generated: genResult.newDirs,
    manualDirs: manualDirNames,
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

  if (result.generated.length > 0) {
    lines.push("Regenerated migrations:")
    for (const g of result.generated) {
      lines.push(`  + ${g}`)
    }
  }

  if (result.manualDirs.length > 0) {
    lines.push("Manual SQL migrations created:")
    for (const m of result.manualDirs) {
      lines.push(`  ~ ${m}`)
    }
  }

  if (result.deleted.length === 0 && result.generated.length === 0) {
    lines.push("Nothing to do.")
  } else {
    lines.push("")
    lines.push("Rebase complete.")
  }

  return lines.join("\n")
}
