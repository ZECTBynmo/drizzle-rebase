import { basename, dirname } from "node:path"
import { getAddedFiles, getMergeBase } from "../git"
import { scanMigrations } from "../migration"
import type { Migration } from "../types"

interface PlanRebaseOptions {
  migrationsDir: string
  baseBranch: string
  cwd: string
}

export interface RebasePlan {
  mine: Migration[]
  kept: Migration[]
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

  const mine = allMigrations.filter((m) => addedDirs.has(m.dirName))
  const kept = allMigrations.filter((m) => !addedDirs.has(m.dirName))

  return { mine, kept }
}

export function formatRebasePlan(plan: RebasePlan): string {
  const lines: string[] = []

  if (plan.mine.length === 0) {
    lines.push("No migrations from your branch found. Nothing to rebase.")
    return lines.join("\n")
  }

  lines.push("Will rebase:")
  for (const m of plan.mine) {
    lines.push(`  - ${m.dirName}`)
  }

  lines.push("")
  lines.push("Steps: backup → rebase snapshots → assign new timestamps")

  return lines.join("\n")
}
