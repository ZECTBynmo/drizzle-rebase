const DDL_PATTERNS = [
  /^CREATE\s+TABLE/i,
  /^ALTER\s+TABLE/i,
  /^DROP\s+TABLE/i,
  /^CREATE\s+(UNIQUE\s+)?INDEX/i,
  /^DROP\s+INDEX/i,
  /^CREATE\s+TYPE/i,
  /^ALTER\s+TYPE/i,
  /^DROP\s+TYPE/i,
  /^CREATE\s+SCHEMA/i,
  /^DROP\s+SCHEMA/i,
  /^ALTER\s+INDEX/i,
  /^CREATE\s+POLICY/i,
  /^ALTER\s+POLICY/i,
  /^DROP\s+POLICY/i,
  /^CREATE\s+ROLE/i,
  /^ALTER\s+ROLE/i,
  /^DROP\s+ROLE/i,
  /^ALTER\s+TABLE\s+.*\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i,
  /^ALTER\s+TABLE\s+.*\s+DISABLE\s+ROW\s+LEVEL\s+SECURITY/i,
]

const DML_PATTERNS = [/^INSERT\s+/i, /^UPDATE\s+/i, /^DELETE\s+/i, /^MERGE\s+/i]

const PROCEDURAL_PATTERNS = [
  /^CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i,
  /^DROP\s+FUNCTION/i,
  /^CREATE\s+(OR\s+REPLACE\s+)?TRIGGER/i,
  /^DROP\s+TRIGGER/i,
  /^CREATE\s+(OR\s+REPLACE\s+)?VIEW/i,
  /^DROP\s+VIEW/i,
  /^CREATE\s+EXTENSION/i,
  /^DROP\s+EXTENSION/i,
  /^CREATE\s+(OR\s+REPLACE\s+)?PROCEDURE/i,
  /^DROP\s+PROCEDURE/i,
  /^DO\s+\$/i,
  /^GRANT\s+/i,
  /^REVOKE\s+/i,
]

const UNTRACKED_DDL_PATTERNS = [
  /^(CREATE|ALTER|DROP)\s+(IF\s+(NOT\s+)?EXISTS\s+)?SEQUENCE/i,
  /^(CREATE|ALTER|DROP)\s+(IF\s+(NOT\s+)?EXISTS\s+)?MATERIALIZED\s+VIEW/i,
  /^(CREATE|ALTER|DROP)\s+(IF\s+(NOT\s+)?EXISTS\s+)?DOMAIN/i,
  /^(CREATE|ALTER|DROP)\s+(IF\s+(NOT\s+)?EXISTS\s+)?AGGREGATE/i,
  /^(CREATE|ALTER|DROP)\s+(IF\s+(NOT\s+)?EXISTS\s+)?RULE/i,
  /^COMMENT\s+ON/i,
]

export type StatementKind = "ddl" | "dml" | "procedural" | "untracked" | "unknown"

export interface ParsedStatement {
  raw: string
  trimmed: string
  kind: StatementKind
}

export function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ""
  let inDollarQuote = false
  let dollarTag = ""

  const lines = sql.split("\n")

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith("--") || trimmed === "") {
      continue
    }

    current += (current ? "\n" : "") + line

    if (inDollarQuote) {
      if (current.includes(dollarTag, current.indexOf(dollarTag) + dollarTag.length)) {
        inDollarQuote = false
      }
    } else {
      const dollarMatch = /(\$[^$]*\$)/.exec(current)
      if (dollarMatch) {
        dollarTag = dollarMatch[1] as string
        const afterFirst = current.indexOf(dollarTag) + dollarTag.length
        if (!current.includes(dollarTag, afterFirst)) {
          inDollarQuote = true
        }
      }
    }

    if (!inDollarQuote && current.trimEnd().endsWith(";")) {
      statements.push(current.trim())
      current = ""
    }
  }

  if (current.trim()) {
    statements.push(current.trim())
  }

  return statements
}

export function classifyStatement(raw: string): ParsedStatement {
  const trimmed = raw.replace(/^--.*\n/gm, "").trim()

  for (const pattern of DML_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { raw, trimmed, kind: "dml" }
    }
  }

  for (const pattern of PROCEDURAL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { raw, trimmed, kind: "procedural" }
    }
  }

  for (const pattern of UNTRACKED_DDL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { raw, trimmed, kind: "untracked" }
    }
  }

  for (const pattern of DDL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { raw, trimmed, kind: "ddl" }
    }
  }

  return { raw, trimmed, kind: "unknown" }
}

export function parseStatements(sql: string): ParsedStatement[] {
  return splitStatements(sql).map(classifyStatement)
}

export interface DdlTarget {
  table?: string
  entityType?: string
  entityName?: string
  indexName?: string
}

/**
 * Extract the identifier after optional qualifiers like IF [NOT] EXISTS, schema prefix, etc.
 * Handles both quoted ("users") and schema-qualified ("public"."users") identifiers.
 */
function extractIdentifier(sql: string, afterKeyword: RegExp): string | null {
  const match = afterKeyword.exec(sql)
  if (!match) return null
  const rest = sql.slice(match.index + match[0].length).trim()
  // Match optional schema-qualified identifier: "public"."users" or public.users or "users" or users
  const identMatch = /^(?:"([^"]+)"\.)?(?:"([^"]+)"|(\S+))/.exec(rest)
  if (!identMatch) return null
  // Return the table/entity name (group 2 for quoted, group 3 for unquoted)
  return identMatch[2] ?? identMatch[3] ?? null
}

export function extractDdlTarget(sql: string): DdlTarget | null {
  const trimmed = sql.replace(/^--.*\n/gm, "").trim()

  // CREATE/ALTER/DROP TABLE
  if (/^(CREATE|ALTER|DROP)\s+TABLE/i.test(trimmed)) {
    const name = extractIdentifier(trimmed, /^(CREATE|ALTER|DROP)\s+TABLE\s+(IF\s+(NOT\s+)?EXISTS\s+)?/i)
    return name ? { table: name } : null
  }

  // CREATE [UNIQUE] INDEX ... ON <table>
  if (/^CREATE\s+(UNIQUE\s+)?INDEX/i.test(trimmed)) {
    const onMatch = /\bON\s+(?:"([^"]+)"\.)?(?:"([^"]+)"|(\S+))/i.exec(trimmed)
    if (onMatch) {
      const table = onMatch[2] ?? onMatch[3] ?? null
      return table ? { table } : null
    }
    return null
  }

  // DROP INDEX / ALTER INDEX (no ON clause)
  if (/^(DROP|ALTER)\s+INDEX/i.test(trimmed)) {
    const onMatch = /\bON\s+/i.exec(trimmed)
    if (onMatch) {
      // Has ON clause — extract table
      const afterOn = trimmed.slice(onMatch.index)
      const tableMatch = /^ON\s+(?:"([^"]+)"\.)?(?:"([^"]+)"|(\S+))/i.exec(afterOn)
      if (tableMatch) {
        const table = tableMatch[2] ?? tableMatch[3] ?? null
        return table ? { table } : null
      }
    }
    // No ON clause — extract index name
    const name = extractIdentifier(trimmed, /^(DROP|ALTER)\s+INDEX\s+(IF\s+EXISTS\s+)?(CONCURRENTLY\s+)?/i)
    return name ? { indexName: name } : null
  }

  // CREATE/ALTER/DROP POLICY ... ON <table>
  if (/^(CREATE|ALTER|DROP)\s+POLICY/i.test(trimmed)) {
    const onMatch = /\bON\s+(?:"([^"]+)"\.)?(?:"([^"]+)"|(\S+))/i.exec(trimmed)
    if (onMatch) {
      const table = onMatch[2] ?? onMatch[3] ?? null
      return table ? { table } : null
    }
    return null
  }

  // ALTER TABLE ... ENABLE/DISABLE ROW LEVEL SECURITY
  if (/^ALTER\s+TABLE\s+.*\s+(ENABLE|DISABLE)\s+ROW\s+LEVEL\s+SECURITY/i.test(trimmed)) {
    const name = extractIdentifier(trimmed, /^ALTER\s+TABLE\s+(IF\s+EXISTS\s+)?/i)
    return name ? { table: name } : null
  }

  // CREATE/ALTER/DROP TYPE
  if (/^(CREATE|ALTER|DROP)\s+TYPE/i.test(trimmed)) {
    const name = extractIdentifier(trimmed, /^(CREATE|ALTER|DROP)\s+TYPE\s+(IF\s+(NOT\s+)?EXISTS\s+)?/i)
    return name ? { entityType: "enums", entityName: name } : null
  }

  // CREATE/ALTER/DROP ROLE
  if (/^(CREATE|ALTER|DROP)\s+ROLE/i.test(trimmed)) {
    const name = extractIdentifier(trimmed, /^(CREATE|ALTER|DROP)\s+ROLE\s+(IF\s+(NOT\s+)?EXISTS\s+)?/i)
    return name ? { entityType: "roles", entityName: name } : null
  }

  // CREATE/DROP SCHEMA — not entity-tracked
  if (/^(CREATE|DROP)\s+SCHEMA/i.test(trimmed)) {
    return null
  }

  return null
}
