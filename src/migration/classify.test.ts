import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { classifyAll } from "./classify"
import { scanMigrations } from "./scan"

const FIXTURES = join(import.meta.dir, "../__fixtures__")

describe("scanMigrations", () => {
  test("scans all fixture migrations in order", async () => {
    const migrations = await scanMigrations(FIXTURES)
    expect(migrations).toHaveLength(7)
    expect(migrations[0]?.dirName).toBe("20250101000000_initial")
    expect(migrations[6]?.dirName).toBe("20250107000000_enable_extension")
  })

  test("migrations are sorted by timestamp", async () => {
    const migrations = await scanMigrations(FIXTURES)
    for (let i = 1; i < migrations.length; i++) {
      const prev = migrations[i - 1]
      const curr = migrations[i]
      if (prev && curr) {
        expect(prev.timestamp < curr.timestamp).toBe(true)
      }
    }
  })

  test("reads SQL content", async () => {
    const migrations = await scanMigrations(FIXTURES)
    expect(migrations[0]?.sql).toContain("CREATE TABLE")
  })

  test("reads snapshot content", async () => {
    const migrations = await scanMigrations(FIXTURES)
    expect(migrations[0]?.snapshot.version).toBe("8")
    expect(migrations[0]?.snapshot.dialect).toBe("postgres")
  })
})

describe("classifyAll", () => {
  test("classifies initial CREATE TABLE as generated", async () => {
    const migrations = await scanMigrations(FIXTURES)
    const classified = classifyAll(migrations)
    expect(classified[0]?.classification).toBe("generated")
    expect(classified[0]?.manualStatements).toHaveLength(0)
  })

  test("classifies ADD COLUMN as generated", async () => {
    const migrations = await scanMigrations(FIXTURES)
    const classified = classifyAll(migrations)
    expect(classified[1]?.classification).toBe("generated")
    expect(classified[1]?.dirName).toBe("20250102000000_add_email")
  })

  test("classifies DML-only backfill as manual", async () => {
    const migrations = await scanMigrations(FIXTURES)
    const classified = classifyAll(migrations)
    const backfill = classified[2]
    expect(backfill?.dirName).toBe("20250103000000_backfill_emails")
    expect(backfill?.classification).toBe("manual")
    expect(backfill?.manualStatements).toHaveLength(1)
    expect(backfill?.manualStatements[0]).toContain("UPDATE")
  })

  test("classifies function creation as manual", async () => {
    const migrations = await scanMigrations(FIXTURES)
    const classified = classifyAll(migrations)
    const fn = classified[3]
    expect(fn?.dirName).toBe("20250104000000_create_function")
    expect(fn?.classification).toBe("manual")
    expect(fn?.manualStatements).toHaveLength(1)
    expect(fn?.manualStatements[0]).toContain("CREATE OR REPLACE FUNCTION")
  })

  test("classifies DDL + DML migration as mixed", async () => {
    const migrations = await scanMigrations(FIXTURES)
    const classified = classifyAll(migrations)
    const mixed = classified[4]
    expect(mixed?.dirName).toBe("20250105000000_mixed_ddl_dml")
    expect(mixed?.classification).toBe("mixed")
    expect(mixed?.manualStatements).toHaveLength(1)
    expect(mixed?.manualStatements[0]).toContain("UPDATE")
  })

  test("classifies index creation as generated", async () => {
    const migrations = await scanMigrations(FIXTURES)
    const classified = classifyAll(migrations)
    expect(classified[5]?.classification).toBe("generated")
    expect(classified[5]?.dirName).toBe("20250106000000_add_index")
  })

  test("classifies extension + grants as manual", async () => {
    const migrations = await scanMigrations(FIXTURES)
    const classified = classifyAll(migrations)
    const ext = classified[6]
    expect(ext?.dirName).toBe("20250107000000_enable_extension")
    expect(ext?.classification).toBe("manual")
    expect(ext?.manualStatements.length).toBeGreaterThan(0)
  })

  test("manual migration has identical prev/current snapshot", async () => {
    const migrations = await scanMigrations(FIXTURES)
    const backfill = migrations[2]
    const prev = migrations[1]
    expect(backfill?.dirName).toBe("20250103000000_backfill_emails")
    expect(JSON.stringify(backfill?.snapshot.ddl)).toBe(JSON.stringify(prev?.snapshot.ddl))
  })

  test("summary counts are correct", async () => {
    const migrations = await scanMigrations(FIXTURES)
    const classified = classifyAll(migrations)
    const generated = classified.filter((m) => m.classification === "generated")
    const manual = classified.filter((m) => m.classification === "manual")
    const mixed = classified.filter((m) => m.classification === "mixed")
    expect(generated).toHaveLength(3)
    expect(manual).toHaveLength(3)
    expect(mixed).toHaveLength(1)
  })
})
