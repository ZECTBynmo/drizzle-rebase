import { describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { buildSnapshotForManualDir, repairSnapshotChain } from "./chain"
import type { Snapshot } from "../types"

function makeSnapshot(id: string, prevIds: string[] = []): Snapshot {
  return {
    version: "8",
    dialect: "postgres",
    id,
    prevIds,
    ddl: [
      {
        entityType: "tables",
        name: "users",
        schema: "public",
        isRlsEnabled: false,
      },
    ],
    renames: [],
  }
}

describe("buildSnapshotForManualDir", () => {
  test("creates new snapshot with same DDL", () => {
    const prev = makeSnapshot("prev-id", ["older-id"])
    const result = buildSnapshotForManualDir(prev)

    expect(result.id).not.toBe(prev.id)
    expect(result.prevIds).toEqual([prev.id])
    expect(result.ddl).toEqual(prev.ddl)
    expect(result.version).toBe("8")
    expect(result.dialect).toBe("postgres")
  })

  test("does not mutate the original snapshot", () => {
    const prev = makeSnapshot("prev-id")
    const originalDdl = JSON.stringify(prev.ddl)
    buildSnapshotForManualDir(prev)
    expect(JSON.stringify(prev.ddl)).toBe(originalDdl)
  })

  test("generates a valid UUID", () => {
    const prev = makeSnapshot("prev-id")
    const result = buildSnapshotForManualDir(prev)
    expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})

describe("repairSnapshotChain", () => {
  const testDir = join(tmpdir(), `drizzle-rebase-test-chain-${Date.now()}`)

  test("fixes prevIds for migrations after startAfter", async () => {
    await mkdir(testDir, { recursive: true })

    const snap1 = makeSnapshot("id-1", [])
    const snap2 = makeSnapshot("id-2", ["wrong-prev"])
    const snap3 = makeSnapshot("id-3", ["also-wrong"])

    const dir1 = join(testDir, "20250101000000_first")
    const dir2 = join(testDir, "20250102000000_second")
    const dir3 = join(testDir, "20250103000000_third")

    await mkdir(dir1, { recursive: true })
    await mkdir(dir2, { recursive: true })
    await mkdir(dir3, { recursive: true })

    await writeFile(join(dir1, "snapshot.json"), JSON.stringify(snap1))
    await writeFile(join(dir2, "snapshot.json"), JSON.stringify(snap2))
    await writeFile(join(dir3, "snapshot.json"), JSON.stringify(snap3))

    await repairSnapshotChain(testDir, "20250101000000")

    const fixed2 = JSON.parse(await readFile(join(dir2, "snapshot.json"), "utf-8")) as Snapshot
    const fixed3 = JSON.parse(await readFile(join(dir3, "snapshot.json"), "utf-8")) as Snapshot

    expect(fixed2.prevIds).toEqual(["id-1"])
    expect(fixed3.prevIds).toEqual(["id-2"])

    const unchanged1 = JSON.parse(await readFile(join(dir1, "snapshot.json"), "utf-8")) as Snapshot
    expect(unchanged1.prevIds).toEqual([])

    await rm(testDir, { recursive: true })
  })

  test("leaves already-correct chains alone", async () => {
    const dir = join(tmpdir(), `drizzle-rebase-test-chain-correct-${Date.now()}`)
    await mkdir(dir, { recursive: true })

    const snap1 = makeSnapshot("id-1", [])
    const snap2 = makeSnapshot("id-2", ["id-1"])

    const dir1 = join(dir, "20250101000000_first")
    const dir2 = join(dir, "20250102000000_second")

    await mkdir(dir1, { recursive: true })
    await mkdir(dir2, { recursive: true })

    await writeFile(join(dir1, "snapshot.json"), JSON.stringify(snap1))
    await writeFile(join(dir2, "snapshot.json"), JSON.stringify(snap2))

    await repairSnapshotChain(dir, "20250101000000")

    const result = JSON.parse(await readFile(join(dir2, "snapshot.json"), "utf-8")) as Snapshot
    expect(result.prevIds).toEqual(["id-1"])

    await rm(dir, { recursive: true })
  })

  test("repairs from empty startAfter (repairs all)", async () => {
    const dir = join(tmpdir(), `drizzle-rebase-test-chain-all-${Date.now()}`)
    await mkdir(dir, { recursive: true })

    const snap1 = makeSnapshot("id-1", [])
    const snap2 = makeSnapshot("id-2", ["wrong"])

    const dir1 = join(dir, "20250101000000_first")
    const dir2 = join(dir, "20250102000000_second")

    await mkdir(dir1, { recursive: true })
    await mkdir(dir2, { recursive: true })

    await writeFile(join(dir1, "snapshot.json"), JSON.stringify(snap1))
    await writeFile(join(dir2, "snapshot.json"), JSON.stringify(snap2))

    await repairSnapshotChain(dir, "")

    const fixed2 = JSON.parse(await readFile(join(dir2, "snapshot.json"), "utf-8")) as Snapshot
    expect(fixed2.prevIds).toEqual(["id-1"])

    await rm(dir, { recursive: true })
  })
})
