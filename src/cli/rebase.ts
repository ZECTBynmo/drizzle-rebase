import { basename, dirname } from "node:path"
import { getAddedFiles, getMergeBase } from "../git"
import { classifyAll, scanMigrations } from "../migration"
import type { ClassifiedMigration } from "../types"

interface RebaseOptions {
  migrationsDir: string
  baseBranch: string
  cwd: string
  dryRun: boolean
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
}: Omit<RebaseOptions, "dryRun">): Promise<RebasePlan> {
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

  if (plan.safeToDelete.length > 0) {
    lines.push("Will delete (generated, safe to regenerate):")
    for (const m of plan.safeToDelete) {
      lines.push(`  - ${m.dirName}`)
    }
  }

  if (plan.needsAttention.length > 0) {
    lines.push("")
    lines.push("Needs manual attention (contains manual SQL):")
    for (const m of plan.needsAttention) {
      lines.push(`  ! ${m.dirName} [${m.classification}]`)
      for (const stmt of m.manualStatements) {
        const preview = stmt.split("\n")[0]?.slice(0, 80) ?? ""
        lines.push(`      ${preview}`)
      }
    }
  }

  if (plan.safeToDelete.length === 0 && plan.needsAttention.length === 0) {
    lines.push("No migrations from your branch found. Nothing to rebase.")
  }

  return lines.join("\n")
}
