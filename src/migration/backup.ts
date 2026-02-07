import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ClassifiedMigration, MigrationBackup } from "../types"

export function backupMigrations(migrations: ClassifiedMigration[]): MigrationBackup[] {
  return migrations.map((m) => ({
    dirName: m.dirName,
    dirPath: m.dirPath,
    sql: m.sql,
    snapshot: structuredClone(m.snapshot),
  }))
}

export async function restoreMigrations(backups: MigrationBackup[]): Promise<void> {
  for (const backup of backups) {
    await mkdir(backup.dirPath, { recursive: true })
    await writeFile(join(backup.dirPath, "migration.sql"), backup.sql)
    await writeFile(join(backup.dirPath, "snapshot.json"), JSON.stringify(backup.snapshot, null, 2))
  }
}

export async function deleteMigrationDirs(migrations: ClassifiedMigration[]): Promise<string[]> {
  const deleted: string[] = []
  for (const m of migrations) {
    await rm(m.dirPath, { recursive: true })
    deleted.push(m.dirName)
  }
  return deleted
}
