import { basename, dirname } from "node:path"
import { getAddedFiles, getMergeBase } from "../git"
import { classifyAll, scanMigrations } from "../migration"
import { validateSlotOrdering } from "../migration/extract"
import type { ClassifiedMigration } from "../types"

interface PlanRebaseOptions {
  migrationsDir: string
  baseBranch: string
  cwd: string
}

export interface RebasePlan {
  safeToDelete: ClassifiedMigration[]
  needsAttention: ClassifiedMigration[]
  kept: ClassifiedMigration[]
}

export async function planRebase({
  migrationsDir,
  baseBranch,
  cwd,
}: PlanRebaseOptions): Promise<RebasePlan> {
  const mergeBase = await getMergeBase(cwd, baseBranch)
  const addedFiles = await getAddedFiles(cwd, mergeBase, migrationsDir)

  const addedDirs = new Set(addedFiles.map((f) => basename(dirname(f))))

  const allMigrations = await scanMigrations(migrationsDir)
  const classified = classifyAll(allMigrations)

  const myMigrations = classified.filter((m) => addedDirs.has(m.dirName))
  const theirMigrations = classified.filter((m) => !addedDirs.has(m.dirName))

  const safeToDelete: ClassifiedMigration[] = []
  const needsAttention: ClassifiedMigration[] = []

  for (const m of myMigrations) {
    if (m.classification === "generated") {
      safeToDelete.push(m)
    } else {
      needsAttention.push(m)
    }
  }

  return { safeToDelete, needsAttention, kept: theirMigrations }
}

export function formatRebasePlan(plan: RebasePlan): string {
  const lines: string[] = []

  if (plan.safeToDelete.length === 0 && plan.needsAttention.length === 0) {
    lines.push("No migrations from your branch found. Nothing to rebase.")
    return lines.join("\n")
  }

  const allMine = [...plan.safeToDelete, ...plan.needsAttention].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  )

  if (plan.needsAttention.length > 0) {
    const interleaveCheck = validateSlotOrdering(allMine)
    if (!interleaveCheck.safe && interleaveCheck.problemSlot) {
      lines.push("BLOCKED: Manual SQL is interleaved between generated migrations.")
      lines.push("")
      lines.push(
        `  Problem: "${interleaveCheck.problemSlot.originalDirName}" has generated migrations on both sides.`,
      )
      lines.push("  When drizzle-kit regenerates, it combines all DDL into one migration,")
      lines.push(
        "  so manual SQL that depends on intermediate DDL steps cannot be placed correctly.",
      )
      lines.push("")
      lines.push("  Fix: split your branch so manual migrations come after all generated ones.")
      return lines.join("\n")
    }
  }

  lines.push("Will delete and regenerate:")
  for (const m of allMine) {
    const tag = m.classification === "generated" ? "generated" : m.classification
    lines.push(`  - ${m.dirName} [${tag}]`)
  }

  if (plan.needsAttention.length > 0) {
    lines.push("")
    lines.push("Will splice manual SQL back after regenerated DDL:")
    for (const m of plan.needsAttention) {
      lines.push(`  ~ ${m.dirName}`)
      for (const stmt of m.manualStatements) {
        const preview = stmt.split("\n")[0]?.slice(0, 80) ?? ""
        lines.push(`      ${preview}`)
      }
    }
  }

  lines.push("")
  if (plan.needsAttention.length > 0) {
    lines.push("Steps: delete → drizzle-kit generate → splice manual SQL → repair snapshots")
  } else {
    lines.push("Steps: delete → drizzle-kit generate")
  }

  return lines.join("\n")
}
