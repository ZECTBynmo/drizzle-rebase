import { diffSnapshots, isEmptyDiff, touchedTables, diffHasEntity, diffHasIndex } from "../snapshot"
import { parseStatements, extractDdlTarget } from "../sql"
import type { ClassifiedMigration, Migration, MigrationClassification } from "../types"

export function classifyMigration(
  migration: Migration,
  previous: Migration | null,
): ClassifiedMigration {
  const prevSnapshot = previous?.snapshot ?? null
  const diff = diffSnapshots(prevSnapshot, migration.snapshot)
  const statements = parseStatements(migration.sql)
  const empty = isEmptyDiff(diff)

  const manualStatements: string[] = []

  for (const stmt of statements) {
    // DML, procedural, untracked, and unknown are always manual
    if (stmt.kind !== "ddl") {
      manualStatements.push(stmt.raw)
      continue
    }

    // DDL with an empty diff can't be drizzle-managed
    if (empty) {
      manualStatements.push(stmt.raw)
      continue
    }

    // DDL with a non-empty diff: check if the target is in the diff
    const target = extractDdlTarget(stmt.raw)

    // Can't extract target — conservative: treat as manual
    if (!target) {
      manualStatements.push(stmt.raw)
      continue
    }

    let isDrizzleManaged = false

    if (target.table) {
      const tables = touchedTables(diff)
      isDrizzleManaged = tables.has(target.table)
    } else if (target.entityType && target.entityName) {
      isDrizzleManaged = diffHasEntity(diff, target.entityType, target.entityName)
    } else if (target.indexName) {
      isDrizzleManaged = diffHasIndex(diff, target.indexName)
    }

    if (!isDrizzleManaged) {
      manualStatements.push(stmt.raw)
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
