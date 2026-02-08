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

export type StatementKind = "ddl" | "dml" | "procedural" | "unknown"

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

