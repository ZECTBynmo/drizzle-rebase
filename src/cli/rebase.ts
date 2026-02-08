import { basename, dirname } from "node:path"
import { getAddedFiles, getMergeBase } from "../git"
import { classifyAll, scanMigrations } from "../migration"
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

  lines.push("Will rebase:")
  for (const m of allMine) {
    const tag = m.classification === "generated" ? "generated" : m.classification
    lines.push(`  - ${m.dirName} [${tag}]`)
  }

  if (plan.needsAttention.length > 0) {
    lines.push("")
    lines.push("Manual/mixed migrations (SQL will be preserved as-is):")
    for (const m of plan.needsAttention) {
      lines.push(`  ~ ${m.dirName}`)
      for (const stmt of m.manualStatements) {
        const preview = stmt.split("\n")[0]?.slice(0, 80) ?? ""
        lines.push(`      ${preview}`)
      }
    }
  }

  lines.push("")
  lines.push("Steps: backup → rebase snapshots → assign new timestamps")

  return lines.join("\n")
}
