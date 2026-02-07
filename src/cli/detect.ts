import { classifyAll } from "../migration"
import { scanMigrations } from "../migration"
import type { ClassifiedMigration } from "../types"

interface DetectOptions {
  migrationsDir: string
}

interface DetectResult {
  migrations: ClassifiedMigration[]
  hasManual: boolean
  hasMixed: boolean
}

export async function detect({ migrationsDir }: DetectOptions): Promise<DetectResult> {
  const migrations = await scanMigrations(migrationsDir)
  const classified = classifyAll(migrations)

  return {
    migrations: classified,
    hasManual: classified.some((m) => m.classification === "manual"),
    hasMixed: classified.some((m) => m.classification === "mixed"),
  }
}

export function formatDetectResult(result: DetectResult): string {
  const lines: string[] = []

  for (const m of result.migrations) {
    const icon =
      m.classification === "generated" ? "  " : m.classification === "manual" ? "! " : "~ "
    const label =
      m.classification === "generated"
        ? "generated"
        : m.classification === "manual"
          ? "MANUAL"
          : "MIXED"

    lines.push(`${icon}${m.dirName} [${label}]`)

    if (m.manualStatements.length > 0) {
      for (const stmt of m.manualStatements) {
        const preview = stmt.split("\n")[0]?.slice(0, 80) ?? ""
        lines.push(`     ${preview}`)
      }
    }
  }

  const total = result.migrations.length
  const generated = result.migrations.filter((m) => m.classification === "generated").length
  const manual = result.migrations.filter((m) => m.classification === "manual").length
  const mixed = result.migrations.filter((m) => m.classification === "mixed").length

  lines.push("")
  lines.push(`${total} migrations: ${generated} generated, ${manual} manual, ${mixed} mixed`)

  return lines.join("\n")
}
