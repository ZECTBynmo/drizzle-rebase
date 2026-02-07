export interface IndexColumn {
  value: string
  isExpression: boolean
  asc: boolean
  nullsFirst: boolean
  opclass: string | null
}

export type DdlEntity =
  | {
      entityType: "tables"
      name: string
      schema: string
      isRlsEnabled: boolean
    }
  | {
      entityType: "enums"
      name: string
      schema: string
      values: string[]
    }
  | {
      entityType: "columns"
      name: string
      schema: string
      table: string
      type: string
      typeSchema: string | null
      notNull: boolean
      dimensions: number
      default: string | null
      generated: string | null
      identity: string | null
    }
  | {
      entityType: "pks"
      name: string
      schema: string
      table: string
      columns: string[]
      nameExplicit: boolean
    }
  | {
      entityType: "uniques"
      name: string
      schema: string
      table: string
      columns: string[]
      nameExplicit: boolean
      nullsNotDistinct: boolean
    }
  | {
      entityType: "fks"
      name: string
      schema: string
      table: string
      columns: string[]
      schemaTo: string
      tableTo: string
      columnsTo: string[]
      onUpdate: string
      onDelete: string
      nameExplicit: boolean
    }
  | {
      entityType: "indexes"
      name: string
      schema: string
      table: string
      nameExplicit: boolean
      columns: IndexColumn[]
      isUnique: boolean
      where: string | null
      with: string
      method: string
      concurrently: boolean
    }
  | {
      entityType: "policies"
      name: string
      schema: string
      table: string
      as: "PERMISSIVE" | "RESTRICTIVE"
      for: "ALL" | "SELECT" | "INSERT" | "UPDATE" | "DELETE"
      roles: string[]
      using: string | null
      withCheck: string | null
    }
  | {
      entityType: "roles"
      name: string
      superuser: boolean | null
      createDb: boolean
      createRole: boolean
      inherit: boolean
      canLogin: boolean | null
      replication: boolean | null
      bypassRls: boolean | null
      connLimit: number | null
      password: string | null
      validUntil: string | null
    }

export interface Snapshot {
  version: string
  dialect: string
  id: string
  prevIds: string[]
  ddl: DdlEntity[]
  renames: unknown[]
}

export interface Migration {
  dirName: string
  dirPath: string
  sql: string
  snapshot: Snapshot
  timestamp: string
  name: string
}

export type MigrationClassification = "generated" | "manual" | "mixed"

export interface ClassifiedMigration extends Migration {
  classification: MigrationClassification
  manualStatements: string[]
}

export interface ManualSlot {
  originalIndex: number
  sql: string[]
  originalDirName: string
  classification: "manual" | "mixed"
}

export interface RebaseResult {
  deleted: string[]
  generated: string[]
  manualDirs: string[]
  success: boolean
  error?: string
}

export interface MigrationBackup {
  dirName: string
  dirPath: string
  sql: string
  snapshot: Snapshot
}
