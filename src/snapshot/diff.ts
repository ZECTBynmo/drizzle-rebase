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

export function diffHasEntity(diff: SnapshotDiff, entityType: string, name: string): boolean {
  function matches(entity: DdlEntity): boolean {
    return entity.entityType === entityType && entity.name === name
  }

  for (const e of diff.added) {
    if (matches(e)) return true
  }
  for (const e of diff.removed) {
    if (matches(e)) return true
  }
  for (const { before, after } of diff.modified) {
    if (matches(before) || matches(after)) return true
  }
  return false
}

export function diffHasIndex(diff: SnapshotDiff, indexName: string): boolean {
  function matches(entity: DdlEntity): boolean {
    return entity.entityType === "indexes" && entity.name === indexName
  }

  for (const e of diff.added) {
    if (matches(e)) return true
  }
  for (const e of diff.removed) {
    if (matches(e)) return true
  }
  for (const { before, after } of diff.modified) {
    if (matches(before) || matches(after)) return true
  }
  return false
}
