import { diffSnapshots, isEmptyDiff } from "../snapshot"
import { parseStatements } from "../sql"
import type { ClassifiedMigration, Migration, MigrationClassification } from "../types"

export function classifyMigration(
  migration: Migration,
  previous: Migration | null,
): ClassifiedMigration {
  const prevSnapshot = previous?.snapshot ?? null
  const diff = diffSnapshots(prevSnapshot, migration.snapshot)
  const statements = parseStatements(migration.sql)

  const manualStatements: string[] = []

  if (isEmptyDiff(diff)) {
    for (const stmt of statements) {
      manualStatements.push(stmt.raw)
    }
  } else {
    for (const stmt of statements) {
      if (stmt.kind === "dml" || stmt.kind === "procedural" || stmt.kind === "unknown") {
        manualStatements.push(stmt.raw)
      }
    }
  }

  let classification: MigrationClassification
  if (manualStatements.length === 0) {
    classification = "generated"
  } else if (manualStatements.length === statements.length) {
    classification = "manual"
  } else {
    classification = "mixed"
  }

  return {
    ...migration,
    classification,
    manualStatements,
  }
}

export function classifyAll(migrations: Migration[]): ClassifiedMigration[] {
  return migrations.map((migration, i) => classifyMigration(migration, migrations[i - 1] ?? null))
}
