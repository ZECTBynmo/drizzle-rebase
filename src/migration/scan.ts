import { readFile, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { parseSnapshot } from "../snapshot"
import type { Migration } from "../types"

const MIGRATION_DIR_PATTERN = /^(\d{14})_(.+)$/

export async function scanMigrations(migrationsDir: string): Promise<Migration[]> {
  const entries = await readdir(migrationsDir)
  const migrations: Migration[] = []

  for (const entry of entries) {
    const match = MIGRATION_DIR_PATTERN.exec(entry)
    if (!match) continue

    const dirPath = join(migrationsDir, entry)
    const stats = await stat(dirPath)
    if (!stats.isDirectory()) continue

    const sqlPath = join(dirPath, "migration.sql")
    const snapshotPath = join(dirPath, "snapshot.json")

    let sql: string
    let snapshot
    try {
      sql = await readFile(sqlPath, "utf-8")
      snapshot = await parseSnapshot(snapshotPath)
    } catch {
      continue
    }

    migrations.push({
      dirName: entry,
      dirPath,
      sql,
      snapshot,
      timestamp: match[1] as string,
      name: match[2] as string,
    })
  }

  return migrations.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
}
