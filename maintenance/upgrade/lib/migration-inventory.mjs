/**
 * Static inventory of a candidate's new SQL migrations, for the
 * schema-compatible rollback gate. It narrows review; it proves nothing.
 * Automatic payload rollback still needs the previous payload exercised against
 * an isolated, migrated database copy.
 *
 * Each statement is classified against the tables that already existed at the
 * base (installed) schema:
 * - destructive: drops, renames, type changes or truncation. The previous
 *   payload can lose data or fail to read.
 * - data-rewrite: UPDATE/DELETE/INSERT on an existing table. History changes.
 * - previous-payload-risk: an existing table gains a rule the previous payload
 *   never satisfied (NOT NULL without default, unique/check/foreign key), or
 *   loses one it may rely on (dropped NOT NULL/default/index/constraint, for
 *   example an ON CONFLICT target).
 * - additive: new tables, their indexes and constraints, nullable or defaulted
 *   columns. The previous payload ignores them.
 */

const STATEMENT_BREAK = /-->\s*statement-breakpoint/;
const IDENT = String.raw`(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?(?:"?[\w]+"?\.)?"?([\w]+)"?`;
const CREATE_TABLE = new RegExp(String.raw`CREATE\s+TABLE\s+${IDENT}`, "gi");

const DESTRUCTIVE = [
  [/\bDROP\s+TABLE\b/i, "drop-table"],
  [/\bDROP\s+COLUMN\b/i, "drop-column"],
  [/\bRENAME\b/i, "rename"],
  [/\bALTER\s+COLUMN\s+"?[\w]+"?\s+(?:SET\s+DATA\s+)?TYPE\b/i, "column-type-change"],
  [/\bTRUNCATE\b/i, "truncate"],
];
const RISK = [
  [/\bCREATE\s+UNIQUE\s+INDEX\b/i, "unique-index"],
  [/\bADD\s+CONSTRAINT\s+"?[\w]+"?\s+UNIQUE\b/i, "unique-constraint"],
  [/\bADD\s+CONSTRAINT\s+"?[\w]+"?\s+CHECK\b/i, "check-constraint"],
  [/\bADD\s+CONSTRAINT\s+"?[\w]+"?\s+FOREIGN\s+KEY\b/i, "foreign-key"],
  [/\bSET\s+NOT\s+NULL\b/i, "set-not-null"],
  [/\bDROP\s+NOT\s+NULL\b/i, "drop-not-null"],
  [/\bDROP\s+DEFAULT\b/i, "drop-default"],
  [/\bDROP\s+CONSTRAINT\b/i, "drop-constraint"],
  [/\bDROP\s+INDEX\b/i, "drop-index"],
  [/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\b/i, "trigger-on-existing-table"],
  [/\bDROP\s+TRIGGER\b/i, "drop-trigger"],
];
const FUNCTION_DEFINITION = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i;
const NO_TABLE_ADDITIVE = /^\s*(?:CREATE\s+(?:TYPE|EXTENSION|SEQUENCE|SCHEMA|STATISTICS)|ANALYZE)\b/i;

function stripComments(sql) {
  return sql.replace(/--(?!>).*$/gm, "");
}

export function splitStatements(sql) {
  return stripComments(sql).split(STATEMENT_BREAK).map((statement) => statement.trim()).filter(Boolean);
}

export function createdTables(sql) {
  return [...stripComments(sql).matchAll(CREATE_TABLE)].map((match) => match[1].toLowerCase());
}

/** Tables a statement touches, from its ALTER/CREATE INDEX/DML targets. */
export function statementTables(statement) {
  const tables = new Set();
  const patterns = [
    new RegExp(String.raw`ALTER\s+TABLE\s+${IDENT}`, "gi"),
    new RegExp(String.raw`CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:"?[\w]+"?\s+)?ON\s+${IDENT}`, "gi"),
    new RegExp(String.raw`(?:^|\s)UPDATE\s+${IDENT}\s+(?:AS\s+"?[\w]+"?\s+)?SET\b`, "gi"),
    new RegExp(String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+"?[\w]+"?[\s\S]*?\sON\s+${IDENT}`, "gi"),
    new RegExp(String.raw`DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?"?[\w]+"?\s+ON\s+${IDENT}`, "gi"),
    new RegExp(String.raw`DELETE\s+FROM\s+${IDENT}`, "gi"),
    new RegExp(String.raw`INSERT\s+INTO\s+${IDENT}`, "gi"),
    new RegExp(String.raw`TRUNCATE\s+(?:TABLE\s+)?${IDENT}`, "gi"),
    new RegExp(String.raw`DROP\s+TABLE\s+${IDENT}`, "gi"),
    CREATE_TABLE,
  ];
  for (const pattern of patterns) for (const match of statement.matchAll(pattern)) tables.add(match[1].toLowerCase());
  return [...tables];
}

function addColumnRisks(statement) {
  const risks = [];
  for (const match of statement.matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([\w]+)"?([^,;]*)/gi)) {
    const definition = match[2];
    if (/\bNOT\s+NULL\b/i.test(definition) && !/\bDEFAULT\b/i.test(definition) && !/\bGENERATED\b/i.test(definition)) {
      risks.push(`add-not-null-column-without-default:${match[1]}`);
    }
  }
  return risks;
}

/**
 * @param {{ baseMigrations: {name: string, sql: string}[], candidateMigrations: {name: string, sql: string}[] }} input
 */
export function inventoryMigrations({ baseMigrations, candidateMigrations }) {
  const existing = new Set(baseMigrations.flatMap(({ sql }) => createdTables(sql)));
  const created = new Set();
  const findings = [];
  const summary = { migrations: candidateMigrations.length, statements: 0, additive: 0, destructive: 0, dataRewrite: 0, previousPayloadRisk: 0, unclassifiedTargets: 0 };
  for (const { name, sql } of candidateMigrations) {
    for (const table of createdTables(sql)) if (!existing.has(table)) created.add(table);
    splitStatements(sql).forEach((statement, index) => {
      summary.statements += 1;
      const tables = statementTables(statement);
      const onExisting = tables.filter((table) => existing.has(table) && !created.has(table));
      const reasons = [];
      let category = "additive";
      // A function body runs only when a trigger or caller invokes it; the
      // trigger statement is what attaches it to an existing table.
      if (FUNCTION_DEFINITION.test(statement)) {
        summary.additive += 1;
        findings.push({ migration: name, statement: index, category, tables: [], reasons: ["function-definition"], text: statement.slice(0, 240) });
        return;
      }
      const destructive = DESTRUCTIVE.filter(([pattern]) => pattern.test(statement)).map(([, reason]) => reason);
      const dml = /(?:^|\s)(?:UPDATE\s+\S+\s+(?:AS\s+\S+\s+)?SET|DELETE\s+FROM|INSERT\s+INTO)\b/i.test(statement);
      if (destructive.length > 0) { category = "destructive"; reasons.push(...destructive); }
      else if (dml && onExisting.length > 0) { category = "data-rewrite"; reasons.push("dml-on-existing-table"); }
      else if (onExisting.length > 0) {
        const risks = [...RISK.filter(([pattern]) => pattern.test(statement)).map(([, reason]) => reason), ...addColumnRisks(statement)];
        if (risks.length > 0) { category = "previous-payload-risk"; reasons.push(...risks); }
      }
      if (tables.length === 0 && category === "additive" && !NO_TABLE_ADDITIVE.test(statement)) {
        // An index dropped by name may be an ON CONFLICT target of the previous
        // payload; procedural blocks need reading. Neither is assumed safe.
        if (/\bDROP\s+INDEX\b/i.test(statement)) { category = "previous-payload-risk"; reasons.push("drop-index"); }
        else {
          summary.unclassifiedTargets += 1;
          category = "previous-payload-risk";
          reasons.push(/\bDO\s+\$/i.test(statement) ? "procedural-block-needs-review" : "no-table-target-recognized");
        }
      }
      if (category === "additive") summary.additive += 1;
      else if (category === "destructive") summary.destructive += 1;
      else if (category === "data-rewrite") summary.dataRewrite += 1;
      else summary.previousPayloadRisk += 1;
      if (category !== "additive" || reasons.length > 0) findings.push({ migration: name, statement: index, category, tables: onExisting.length ? onExisting : tables, reasons, text: statement.slice(0, 240) });
    });
  }
  return {
    summary,
    findings,
    staticOnly: true,
    rollbackAutomaticallySafe: false,
    note: "Static inventory only. Automatic payload rollback requires the previous payload exercised against an isolated migrated copy.",
  };
}
