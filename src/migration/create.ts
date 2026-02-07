import { mkdir, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Snapshot } from "../types"

export function nextTimestamp(after: string, existing: string[]): string {
  let candidate = String(BigInt(after) + 1n)
  while (existing.includes(candidate)) {
    candidate = String(BigInt(candidate) + 1n)
  }
  return candidate
}

export interface CreateMigrationDirOptions {
  migrationsDir: string
  name: string
  sql: string
  snapshot: Snapshot
  afterTimestamp: string
}

export interface CreatedMigrationDir {
  dirName: string
  dirPath: string
  timestamp: string
}

export async function createMigrationDir({
  migrationsDir,
  name,
  sql,
  snapshot,
  afterTimestamp,
}: CreateMigrationDirOptions): Promise<CreatedMigrationDir> {
  const existingEntries = await readdir(migrationsDir)
  const existingTimestamps = existingEntries
    .map((e) => e.match(/^(\d{14})_/)?.[1])
    .filter((t): t is string => t != null)

  const timestamp = nextTimestamp(afterTimestamp, existingTimestamps)
  const dirName = `${timestamp}_${name}`
  const dirPath = join(migrationsDir, dirName)

  await mkdir(dirPath, { recursive: true })
  await writeFile(join(dirPath, "migration.sql"), sql)
  await writeFile(join(dirPath, "snapshot.json"), JSON.stringify(snapshot, null, 2))

  return { dirName, dirPath, timestamp }
}
