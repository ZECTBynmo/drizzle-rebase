import { readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Snapshot } from "../types"

export async function repairSnapshotChain(
  migrationsDir: string,
  startAfter: string,
): Promise<void> {
  const entries = await readdir(migrationsDir)
  const migrationDirs = entries.filter((e) => /^\d{14}_/.test(e)).sort()

  let prevId: string | null = null
  let pastStart = startAfter === ""

  for (const dirName of migrationDirs) {
    const snapshotPath = join(migrationsDir, dirName, "snapshot.json")
    let snapshot: Snapshot
    try {
      const raw = await readFile(snapshotPath, "utf-8")
      snapshot = JSON.parse(raw) as Snapshot
    } catch {
      continue
    }

    const timestamp = dirName.match(/^(\d{14})_/)?.[1]
    if (!pastStart) {
      if (timestamp && timestamp > startAfter) {
        pastStart = true
      } else {
        prevId = snapshot.id
        continue
      }
    }

    if (prevId !== null) {
      const expectedPrevIds = [prevId]
      if (JSON.stringify(snapshot.prevIds) !== JSON.stringify(expectedPrevIds)) {
        snapshot.prevIds = expectedPrevIds
        await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2))
      }
    }

    prevId = snapshot.id
  }
}
