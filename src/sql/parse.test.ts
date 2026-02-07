import { describe, expect, test } from "bun:test"
import { classifyStatement, extractDdlTarget, parseStatements, splitStatements } from "./parse"

describe("splitStatements", () => {
  test("splits simple semicolon-terminated statements", () => {
    const sql = `CREATE TABLE "users" ("id" uuid);
ALTER TABLE "users" ADD COLUMN "name" text;`
    const stmts = splitStatements(sql)
    expect(stmts).toHaveLength(2)
  })

  test("skips comment-only lines", () => {
    const sql = `-- this is a comment
CREATE TABLE "users" ("id" uuid);
-- another comment
ALTER TABLE "users" ADD COLUMN "name" text;`
    const stmts = splitStatements(sql)
    expect(stmts).toHaveLength(2)
  })

  test("skips empty lines", () => {
    const sql = `CREATE TABLE "users" ("id" uuid);

ALTER TABLE "users" ADD COLUMN "name" text;`
    const stmts = splitStatements(sql)
    expect(stmts).toHaveLength(2)
  })

  test("handles dollar-quoted function bodies", () => {
    const sql = `CREATE OR REPLACE FUNCTION my_func()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE users SET name = 'test';
END;
$$;`
    const stmts = splitStatements(sql)
    expect(stmts).toHaveLength(1)
    expect(stmts[0]).toContain("$$")
    expect(stmts[0]).toContain("UPDATE users")
  })

  test("handles custom dollar-quote tags", () => {
    const sql = `CREATE FUNCTION test()
RETURNS void
LANGUAGE sql
AS $func$
  SELECT 1;
$func$;`
    const stmts = splitStatements(sql)
    expect(stmts).toHaveLength(1)
  })

  test("handles DO blocks", () => {
    const sql = `DO $$ BEGIN
  RAISE NOTICE 'hello';
EXCEPTION WHEN insufficient_privilege THEN
  NULL;
END $$;`
    const stmts = splitStatements(sql)
    expect(stmts).toHaveLength(1)
  })

  test("handles multi-line CREATE TABLE", () => {
    const sql = `CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text
);`
    const stmts = splitStatements(sql)
    expect(stmts).toHaveLength(1)
    expect(stmts[0]).toContain('"email"')
  })

  test("handles statement without trailing semicolon", () => {
    const sql = `CREATE TABLE "test" ("id" uuid)`
    const stmts = splitStatements(sql)
    expect(stmts).toHaveLength(1)
  })
})

describe("classifyStatement", () => {
  test("classifies CREATE TABLE as ddl", () => {
    const result = classifyStatement('CREATE TABLE "users" ("id" uuid);')
    expect(result.kind).toBe("ddl")
  })

  test("classifies ALTER TABLE as ddl", () => {
    const result = classifyStatement('ALTER TABLE "users" ADD COLUMN "email" text;')
    expect(result.kind).toBe("ddl")
  })

  test("classifies DROP TABLE as ddl", () => {
    const result = classifyStatement('DROP TABLE "users";')
    expect(result.kind).toBe("ddl")
  })

  test("classifies CREATE INDEX as ddl", () => {
    const result = classifyStatement(
      'CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");',
    )
    expect(result.kind).toBe("ddl")
  })

  test("classifies CREATE TYPE as ddl", () => {
    const result = classifyStatement("CREATE TYPE \"status\" AS ENUM ('active', 'inactive');")
    expect(result.kind).toBe("ddl")
  })

  test("classifies CREATE POLICY as ddl", () => {
    const result = classifyStatement(
      'CREATE POLICY "users_policy" ON "users" FOR SELECT USING (true);',
    )
    expect(result.kind).toBe("ddl")
  })

  test("classifies ALTER TABLE ENABLE RLS as ddl", () => {
    const result = classifyStatement('ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;')
    expect(result.kind).toBe("ddl")
  })

  test("classifies INSERT as dml", () => {
    const result = classifyStatement("INSERT INTO users (name) VALUES ('test');")
    expect(result.kind).toBe("dml")
  })

  test("classifies UPDATE as dml", () => {
    const result = classifyStatement('UPDATE "users" SET "email" = \'test@test.com\';')
    expect(result.kind).toBe("dml")
  })

  test("classifies DELETE as dml", () => {
    const result = classifyStatement('DELETE FROM "users" WHERE "email" IS NULL;')
    expect(result.kind).toBe("dml")
  })

  test("classifies CREATE FUNCTION as procedural", () => {
    const result = classifyStatement(
      "CREATE OR REPLACE FUNCTION my_func() RETURNS void AS $$ BEGIN END; $$;",
    )
    expect(result.kind).toBe("procedural")
  })

  test("classifies DROP FUNCTION as procedural", () => {
    const result = classifyStatement("DROP FUNCTION IF EXISTS my_func;")
    expect(result.kind).toBe("procedural")
  })

  test("classifies CREATE TRIGGER as procedural", () => {
    const result = classifyStatement(
      'CREATE TRIGGER my_trigger BEFORE INSERT ON "users" EXECUTE FUNCTION my_func();',
    )
    expect(result.kind).toBe("procedural")
  })

  test("classifies CREATE EXTENSION as procedural", () => {
    const result = classifyStatement("CREATE EXTENSION IF NOT EXISTS vector;")
    expect(result.kind).toBe("procedural")
  })

  test("classifies GRANT as procedural", () => {
    const result = classifyStatement('GRANT SELECT ON ALL TABLES IN SCHEMA public TO "app-user";')
    expect(result.kind).toBe("procedural")
  })

  test("classifies DO blocks as procedural", () => {
    const result = classifyStatement("DO $$ BEGIN RAISE NOTICE 'test'; END $$;")
    expect(result.kind).toBe("procedural")
  })

  test("classifies unknown statements", () => {
    const result = classifyStatement("VACUUM ANALYZE users;")
    expect(result.kind).toBe("unknown")
  })

  test("classifies CREATE SEQUENCE as untracked", () => {
    const result = classifyStatement("CREATE SEQUENCE my_seq START 1;")
    expect(result.kind).toBe("untracked")
  })

  test("classifies ALTER SEQUENCE as untracked", () => {
    const result = classifyStatement("ALTER SEQUENCE my_seq RESTART WITH 100;")
    expect(result.kind).toBe("untracked")
  })

  test("classifies DROP SEQUENCE as untracked", () => {
    const result = classifyStatement("DROP SEQUENCE IF EXISTS my_seq;")
    expect(result.kind).toBe("untracked")
  })

  test("classifies CREATE MATERIALIZED VIEW as untracked", () => {
    const result = classifyStatement('CREATE MATERIALIZED VIEW my_view AS SELECT * FROM "users";')
    expect(result.kind).toBe("untracked")
  })

  test("classifies DROP MATERIALIZED VIEW as untracked", () => {
    const result = classifyStatement("DROP MATERIALIZED VIEW IF EXISTS my_view;")
    expect(result.kind).toBe("untracked")
  })

  test("classifies CREATE DOMAIN as untracked", () => {
    const result = classifyStatement("CREATE DOMAIN email_type AS text CHECK (VALUE ~ '@');")
    expect(result.kind).toBe("untracked")
  })

  test("classifies COMMENT ON as untracked", () => {
    const result = classifyStatement("COMMENT ON TABLE users IS 'Main users table';")
    expect(result.kind).toBe("untracked")
  })

  test("classifies CREATE AGGREGATE as untracked", () => {
    const result = classifyStatement("CREATE AGGREGATE my_agg (integer) (sfunc = int4pl, stype = int4);")
    expect(result.kind).toBe("untracked")
  })

  test("classifies CREATE RULE as untracked", () => {
    const result = classifyStatement('CREATE RULE my_rule AS ON INSERT TO "users" DO NOTHING;')
    expect(result.kind).toBe("untracked")
  })
})

describe("parseStatements", () => {
  test("parses a complete migration with mixed content", () => {
    const sql = `-- Backfill then make NOT NULL
UPDATE "users" SET "email" = 'unknown@example.com' WHERE "email" IS NULL;
ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL;`
    const stmts = parseStatements(sql)
    expect(stmts).toHaveLength(2)
    expect(stmts[0]?.kind).toBe("dml")
    expect(stmts[1]?.kind).toBe("ddl")
  })

  test("parses extension + grant migration", () => {
    const sql = `CREATE EXTENSION IF NOT EXISTS vector;
GRANT USAGE ON SCHEMA public TO "app-user";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "app-user";`
    const stmts = parseStatements(sql)
    expect(stmts).toHaveLength(3)
    expect(stmts[0]?.kind).toBe("procedural")
    expect(stmts[1]?.kind).toBe("procedural")
    expect(stmts[2]?.kind).toBe("procedural")
  })
})

describe("extractDdlTarget", () => {
  test("extracts table from CREATE TABLE", () => {
    const target = extractDdlTarget('CREATE TABLE "users" ("id" uuid);')
    expect(target).toEqual({ table: "users" })
  })

  test("extracts table from ALTER TABLE", () => {
    const target = extractDdlTarget('ALTER TABLE "users" ADD COLUMN "email" text;')
    expect(target).toEqual({ table: "users" })
  })

  test("extracts table from DROP TABLE", () => {
    const target = extractDdlTarget('DROP TABLE IF EXISTS "users";')
    expect(target).toEqual({ table: "users" })
  })

  test("extracts table from schema-qualified CREATE TABLE", () => {
    const target = extractDdlTarget('CREATE TABLE "public"."users" ("id" uuid);')
    expect(target).toEqual({ table: "users" })
  })

  test("extracts table from CREATE INDEX ... ON", () => {
    const target = extractDdlTarget('CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");')
    expect(target).toEqual({ table: "users" })
  })

  test("extracts table from CREATE INDEX with schema-qualified ON", () => {
    const target = extractDdlTarget('CREATE INDEX "idx" ON "public"."users" ("email");')
    expect(target).toEqual({ table: "users" })
  })

  test("extracts index name from DROP INDEX without ON", () => {
    const target = extractDdlTarget('DROP INDEX IF EXISTS "users_email_idx";')
    expect(target).toEqual({ indexName: "users_email_idx" })
  })

  test("extracts index name from ALTER INDEX without ON", () => {
    const target = extractDdlTarget('ALTER INDEX "users_email_idx" RENAME TO "idx_email";')
    expect(target).toEqual({ indexName: "users_email_idx" })
  })

  test("extracts table from CREATE POLICY ... ON", () => {
    const target = extractDdlTarget('CREATE POLICY "users_policy" ON "users" FOR SELECT USING (true);')
    expect(target).toEqual({ table: "users" })
  })

  test("extracts table from DROP POLICY ... ON", () => {
    const target = extractDdlTarget('DROP POLICY "users_policy" ON "users";')
    expect(target).toEqual({ table: "users" })
  })

  test("extracts entity from CREATE TYPE", () => {
    const target = extractDdlTarget("CREATE TYPE \"status\" AS ENUM ('active', 'inactive');")
    expect(target).toEqual({ entityType: "enums", entityName: "status" })
  })

  test("extracts entity from DROP TYPE", () => {
    const target = extractDdlTarget('DROP TYPE IF EXISTS "status";')
    expect(target).toEqual({ entityType: "enums", entityName: "status" })
  })

  test("extracts entity from CREATE ROLE", () => {
    const target = extractDdlTarget('CREATE ROLE "app_user" WITH LOGIN;')
    expect(target).toEqual({ entityType: "roles", entityName: "app_user" })
  })

  test("extracts entity from DROP ROLE", () => {
    const target = extractDdlTarget('DROP ROLE IF EXISTS "app_user";')
    expect(target).toEqual({ entityType: "roles", entityName: "app_user" })
  })

  test("returns null for CREATE SCHEMA", () => {
    const target = extractDdlTarget('CREATE SCHEMA "my_schema";')
    expect(target).toBeNull()
  })

  test("returns null for DROP SCHEMA", () => {
    const target = extractDdlTarget('DROP SCHEMA "my_schema" CASCADE;')
    expect(target).toBeNull()
  })

  test("extracts table from ALTER TABLE ENABLE RLS", () => {
    const target = extractDdlTarget('ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;')
    expect(target).toEqual({ table: "users" })
  })

  test("returns null for unparseable SQL", () => {
    const target = extractDdlTarget("VACUUM ANALYZE users;")
    expect(target).toBeNull()
  })
})
