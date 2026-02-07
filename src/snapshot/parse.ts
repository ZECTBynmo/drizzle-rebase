import { readFile } from "node:fs/promises"
import type { Snapshot } from "../types"

export async function parseSnapshot(path: string): Promise<Snapshot> {
  const raw = await readFile(path, "utf-8")
  return JSON.parse(raw) as Snapshot
}
