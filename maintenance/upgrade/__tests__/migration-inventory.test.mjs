import assert from "node:assert/strict";
import test from "node:test";
import { inventoryMigrations, splitStatements, statementTables } from "../lib/migration-inventory.mjs";

const base = [{ name: "0001_base.sql", sql: 'CREATE TABLE "issues" ("id" uuid PRIMARY KEY);\n--> statement-breakpoint\nCREATE TABLE IF NOT EXISTS agents ("id" uuid);' }];
const run = (sql) => inventoryMigrations({ baseMigrations: base, candidateMigrations: [{ name: "0002_new.sql", sql }] });
const categoryOf = (sql) => {
  const result = run(sql);
  return { categories: result.findings.map((f) => f.category), reasons: result.findings.flatMap((f) => f.reasons), summary: result.summary };
};

test("splits drizzle statements and ignores SQL comments", () => {
  assert.deepEqual(splitStatements("-- note\nSELECT 1;--> statement-breakpoint\nSELECT 2;"), ["SELECT 1;", "SELECT 2;"]);
  assert.deepEqual(statementTables('ALTER TABLE IF EXISTS ONLY "public"."issues" ADD COLUMN "x" text'), ["issues"]);
  assert.deepEqual(statementTables('UPDATE "issues" AS "i" SET "x" = 1'), ["issues"]);
  assert.deepEqual(statementTables("CREATE TRIGGER t AFTER UPDATE OF status ON issues FOR EACH ROW EXECUTE FUNCTION f();"), ["issues"]);
});

test("new tables and nullable or defaulted columns are additive", () => {
  const result = run('CREATE TABLE "jobs" ("id" uuid NOT NULL);\n--> statement-breakpoint\nCREATE UNIQUE INDEX "jobs_uq" ON "jobs" ("id");\n--> statement-breakpoint\nALTER TABLE "jobs" ADD CONSTRAINT "jobs_fk" FOREIGN KEY ("id") REFERENCES "issues"("id");\n--> statement-breakpoint\nALTER TABLE "issues" ADD COLUMN "note" text;\n--> statement-breakpoint\nALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "rev" integer DEFAULT 0 NOT NULL;');
  assert.deepEqual(result.summary, { migrations: 1, statements: 5, additive: 5, destructive: 0, dataRewrite: 0, previousPayloadRisk: 0, unclassifiedTargets: 0 });
  assert.equal(result.rollbackAutomaticallySafe, false, "static inventory never certifies rollback");
});

test("rules added to existing tables are previous-payload risks", () => {
  for (const [sql, reason] of [
    ['ALTER TABLE "issues" ADD COLUMN "owner" uuid NOT NULL;', "add-not-null-column-without-default:owner"],
    ['CREATE UNIQUE INDEX "issues_uq" ON "issues" ("id");', "unique-index"],
    ['ALTER TABLE "issues" ADD CONSTRAINT "issues_ck" CHECK (true);', "check-constraint"],
    ['ALTER TABLE "agents" ADD CONSTRAINT "a_fk" FOREIGN KEY ("id") REFERENCES "issues"("id");', "foreign-key"],
    ['ALTER TABLE "issues" ALTER COLUMN "id" DROP NOT NULL;', "drop-not-null"],
    ['ALTER TABLE "issues" DROP CONSTRAINT IF EXISTS "x";', "drop-constraint"],
    ["CREATE TRIGGER t BEFORE UPDATE ON issues FOR EACH ROW EXECUTE FUNCTION f();", "trigger-on-existing-table"],
    ['DROP INDEX IF EXISTS "issues_uniq";', "drop-index"],
  ]) {
    const result = categoryOf(sql);
    assert.deepEqual(result.categories, ["previous-payload-risk"], sql);
    assert.ok(result.reasons.includes(reason), `${sql} -> ${result.reasons}`);
  }
});

test("drops, renames, type changes and rewrites of existing data are flagged", () => {
  assert.deepEqual(categoryOf('ALTER TABLE "issues" DROP COLUMN "x";').categories, ["destructive"]);
  assert.deepEqual(categoryOf('ALTER TABLE "issues" RENAME COLUMN "a" TO "b";').categories, ["destructive"]);
  assert.deepEqual(categoryOf('ALTER TABLE "issues" ALTER COLUMN "id" SET DATA TYPE text;').categories, ["destructive"]);
  assert.deepEqual(categoryOf('DROP TABLE "agents";').categories, ["destructive"]);
  assert.deepEqual(categoryOf('UPDATE "issues" AS "i" SET "x" = NULL WHERE true;').categories, ["data-rewrite"]);
  assert.deepEqual(categoryOf('INSERT INTO "agents" ("id") SELECT "id" FROM "issues";').categories, ["data-rewrite"]);
});

test("function bodies are definitions; procedural blocks and unknown targets need review", () => {
  const fn = categoryOf("CREATE OR REPLACE FUNCTION f() RETURNS trigger AS $$ BEGIN INSERT INTO agents VALUES (NEW.id); RETURN NEW; END $$ LANGUAGE plpgsql;");
  assert.deepEqual(fn.categories, ["additive"]);
  assert.deepEqual(fn.reasons, ["function-definition"]);
  const block = categoryOf("DO $$ BEGIN PERFORM 1; END $$;");
  assert.deepEqual(block.categories, ["previous-payload-risk"]);
  assert.deepEqual(block.reasons, ["procedural-block-needs-review"]);
  assert.equal(block.summary.unclassifiedTargets, 1);
  assert.deepEqual(categoryOf('ANALYZE "issues";').categories, []);
});
