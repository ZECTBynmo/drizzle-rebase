import { cp, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import type { Migration, BackupHandle } from "../types"

const BACKUP_DIR_NAME = ".drizzle-rebase-backup"

export async function backupMigrations(
  migrationsDir: string,
  migrations: Migration[],
): Promise<BackupHandle> {
  const backupDir = join(migrationsDir, BACKUP_DIR_NAME)

  // Remove stale backup if present
  await rm(backupDir, { recursive: true, force: true })
  await mkdir(backupDir, { recursive: true })

  const backedUpDirNames: string[] = []

  for (const m of migrations) {
    await cp(m.dirPath, join(backupDir, m.dirName), { recursive: true })
    backedUpDirNames.push(m.dirName)
  }

  return { backupDir, backedUpDirNames }
}

export async function restoreMigrations(
  migrationsDir: string,
  handle: BackupHandle,
): Promise<void> {
  for (const dirName of handle.backedUpDirNames) {
    const src = join(handle.backupDir, dirName)
    const dest = join(migrationsDir, dirName)
    await cp(src, dest, { recursive: true })
  }
}

export async function cleanupBackup(handle: BackupHandle): Promise<void> {
  await rm(handle.backupDir, { recursive: true, force: true })
}

export async function deleteMigrationDirs(migrations: Migration[]): Promise<string[]> {
  const deleted: string[] = []
  for (const m of migrations) {
    await rm(m.dirPath, { recursive: true })
    deleted.push(m.dirName)
  }
  return deleted
}
