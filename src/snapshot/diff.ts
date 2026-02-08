import type { DdlEntity, Snapshot } from "../types"

function entityKey(entity: DdlEntity): string {
  const base = entity.entityType
  switch (entity.entityType) {
    case "tables":
      return `${base}:${entity.schema}.${entity.name}`
    case "enums":
      return `${base}:${entity.schema}.${entity.name}`
    case "columns":
      return `${base}:${entity.schema}.${entity.table}.${entity.name}`
    case "pks":
      return `${base}:${entity.schema}.${entity.table}.${entity.name}`
    case "uniques":
      return `${base}:${entity.schema}.${entity.table}.${entity.name}`
    case "fks":
      return `${base}:${entity.schema}.${entity.table}.${entity.name}`
    case "indexes":
      return `${base}:${entity.schema}.${entity.table}.${entity.name}`
    case "policies":
      return `${base}:${entity.schema}.${entity.table}.${entity.name}`
    case "roles":
      return `${base}:${entity.name}`
    default: {
      const _exhaustive: never = entity
      throw new Error(`Unknown entity type: ${(_exhaustive as DdlEntity).entityType}`)
    }
  }
}

export interface SnapshotDiff {
  added: DdlEntity[]
  removed: DdlEntity[]
  modified: Array<{ before: DdlEntity; after: DdlEntity }>
}

export function diffSnapshots(before: Snapshot | null, after: Snapshot): SnapshotDiff {
  const beforeMap = new Map<string, DdlEntity>()
  const afterMap = new Map<string, DdlEntity>()

  if (before) {
    for (const entity of before.ddl) {
      beforeMap.set(entityKey(entity), entity)
    }
  }
  for (const entity of after.ddl) {
    afterMap.set(entityKey(entity), entity)
  }

  const added: DdlEntity[] = []
  const removed: DdlEntity[] = []
  const modified: Array<{ before: DdlEntity; after: DdlEntity }> = []

  for (const [key, entity] of afterMap) {
    const prev = beforeMap.get(key)
    if (!prev) {
      added.push(entity)
    } else if (JSON.stringify(prev) !== JSON.stringify(entity)) {
      modified.push({ before: prev, after: entity })
    }
  }

  for (const [key, entity] of beforeMap) {
    if (!afterMap.has(key)) {
      removed.push(entity)
    }
  }

  return { added, removed, modified }
}

export function isEmptyDiff(diff: SnapshotDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0
}

export function touchedTables(diff: SnapshotDiff): Set<string> {
  const tables = new Set<string>()

  function addTable(entity: DdlEntity) {
    if ("table" in entity) {
      tables.add(entity.table)
    }
    if (entity.entityType === "tables") {
      tables.add(entity.name)
    }
  }

  for (const e of diff.added) addTable(e)
  for (const e of diff.removed) addTable(e)
  for (const { before, after } of diff.modified) {
    addTable(before)
    addTable(after)
  }

  return tables
}

export interface SnapshotConflict {
  entityKey: string
  type: "add-exists" | "remove-modified" | "modify-diverged"
  mine: DdlEntity
  theirs: DdlEntity
}

export interface ApplyDiffResult {
  snapshot: Snapshot
  conflicts: SnapshotConflict[]
}

export function applyDiff(
  base: Snapshot | null,
  diff: SnapshotDiff,
  prevId: string,
): ApplyDiffResult {
  const entityMap = new Map<string, DdlEntity>()
  if (base) {
    for (const entity of base.ddl) {
      entityMap.set(entityKey(entity), structuredClone(entity))
    }
  }

  const conflicts: SnapshotConflict[] = []

  for (const entity of diff.added) {
    const key = entityKey(entity)
    const existing = entityMap.get(key)
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(entity)) {
        conflicts.push({ entityKey: key, type: "add-exists", mine: entity, theirs: existing })
      }
      // identical → skip (already exists)
    } else {
      entityMap.set(key, structuredClone(entity))
    }
  }

  for (const entity of diff.removed) {
    const key = entityKey(entity)
    const existing = entityMap.get(key)
    if (!existing) {
      // doesn't exist → skip
    } else if (JSON.stringify(existing) !== JSON.stringify(entity)) {
      conflicts.push({ entityKey: key, type: "remove-modified", mine: entity, theirs: existing })
    } else {
      entityMap.delete(key)
    }
  }

  for (const { before, after } of diff.modified) {
    const key = entityKey(before)
    const existing = entityMap.get(key)
    if (!existing) {
      // entity doesn't exist in base — apply the after anyway
      entityMap.set(key, structuredClone(after))
    } else if (JSON.stringify(existing) !== JSON.stringify(before)) {
      // base entity doesn't match before → they also modified it
      conflicts.push({ entityKey: key, type: "modify-diverged", mine: after, theirs: existing })
    } else {
      entityMap.set(key, structuredClone(after))
    }
  }

  const snapshot: Snapshot = {
    version: base?.version ?? "8",
    dialect: base?.dialect ?? "postgres",
    id: crypto.randomUUID(),
    prevIds: [prevId],
    ddl: [...entityMap.values()],
    renames: [],
  }

  return { snapshot, conflicts }
}

