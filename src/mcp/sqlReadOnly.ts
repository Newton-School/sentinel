/**
 * Read-only SQL guard for the Metabase MCP server.
 *
 * This is a pure module (no side effects, no server bootstrap) so it can be
 * imported directly in unit tests. `metabase.ts` calls `assertReadOnlySql`
 * inside the `metabase_query` handler BEFORE forwarding SQL to Metabase's
 * `/api/dataset` endpoint, enforcing read-only access at the tool boundary.
 *
 * Rationale: the Claude CLI runs with `--dangerously-skip-permissions`, so a
 * prompt-injected or hallucinated mutating statement could otherwise execute
 * against the warehouse if the account has write grants.
 *
 * Strategy (parser-first, regex-fallback):
 *   1. Try to parse the SQL into an AST with node-sql-parser (MySQL dialect).
 *      If it parses, inspect the AST and allow ONLY read-only statements
 *      (SELECT / CTE-resolving-to-SELECT / EXPLAIN / SHOW / DESCRIBE|DESC).
 *      Because the AST ignores string-literal contents and normalizes
 *      parenthesized/UNION selects, valid reads like
 *      `WHERE action = 'delete'` and `(SELECT …) UNION (SELECT …)` PASS —
 *      these were false-rejected by the keyword regex alone.
 *   2. If parsing THROWS (a dialect quirk or syntax the parser can't model),
 *      FALL BACK to the regex guard's verdict. The fallback is never more
 *      lenient than the AST path, so the guard is never more restrictive than
 *      it was before for unparseable-but-valid warehouse SQL, only strictly
 *      better when the SQL is parseable.
 */

import pkg from "node-sql-parser";

const { Parser } = pkg;

/** Keywords a query may *start* with to be considered read-only. */
const ALLOWED_LEADING_KEYWORDS = [
  "SELECT",
  "WITH",
  "EXPLAIN",
  "SHOW",
  "DESCRIBE",
  "DESC",
];

/**
 * Forbidden DML/DDL/admin keywords rejected if they appear as a whole word
 * (\b, so `updated_at`/`created_at`/`deleted_at` are NOT false-positives)
 * ANYWHERE in the statement — not just at the start.
 *
 * This anywhere-check is not mere paranoia: a query that starts with an allowed
 * keyword can still mutate data inside a single statement via
 *   - data-modifying CTEs, e.g. `WITH x AS (DELETE FROM t RETURNING *) SELECT ...`
 *   - `SELECT ... INTO new_table ...` (creates a table)
 * so INSERT/UPDATE/DELETE/INTO etc. must be blocked wherever they appear.
 *
 * NOTE: dual-use keywords that are also legitimate read-side functions or
 * identifiers (e.g. `REPLACE()`, `MERGE`) are intentionally NOT in this list —
 * blocking them anywhere false-rejects valid reads like
 * `SELECT REPLACE(name,' ','_') FROM t`. They remain blocked as *statement
 * starters* by the ALLOWED_LEADING_KEYWORDS allowlist (a query may only begin
 * with SELECT/WITH/EXPLAIN/SHOW/DESCRIBE), and stacked statements are rejected
 * separately, so `REPLACE INTO ...` / `MERGE INTO ...` are still refused.
 */
const FORBIDDEN_ANYWHERE_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "ALTER",
  "CREATE",
  "TRUNCATE",
  "GRANT",
  "REVOKE",
  "CALL",
  "EXEC",
  "EXECUTE",
  "ATTACH",
  "DETACH",
  "VACUUM",
  "PRAGMA",
  "COPY",
  "INTO",
];

/**
 * AST `type` values that represent read-only statements. node-sql-parser
 * (MySQL dialect) normalizes:
 *   - SELECT / parenthesized SELECT / UNION / WITH…SELECT  -> "select"
 *   - EXPLAIN [SELECT …]                                   -> "explain"
 *   - SHOW …                                               -> "show"
 *   - DESCRIBE / DESC …                                    -> "desc"
 * Any other top-level type (insert/update/delete/drop/alter/create/truncate/
 * grant/revoke/replace/…) is a write/DDL/DCL and is rejected.
 */
const READ_ONLY_AST_TYPES = new Set(["select", "explain", "show", "desc"]);

/**
 * Remove SQL line comments (`-- ...`) and block comments (`/* ... *​/`),
 * then trim surrounding whitespace.
 */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/--[^\n]*/g, " ") // line comments
    .trim();
}

/**
 * Regex-based read-only guard. This is the historical implementation, kept as
 * the fallback path for SQL that node-sql-parser cannot parse. Throws an Error
 * if `sql` is not a safe, single, read-only statement; returns void otherwise.
 */
function assertReadOnlySqlRegex(sql: string): void {
  const cleaned = stripComments(sql);

  if (cleaned.length === 0) {
    throw new Error("Rejected: empty SQL (no statement after stripping comments).");
  }

  // Reject multiple statements. A single trailing `;` is allowed.
  const statements = cleaned
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (statements.length > 1) {
    throw new Error(
      "Rejected: multiple SQL statements are not allowed (only a single read-only query)."
    );
  }

  const statement = statements[0];

  // Require the first significant keyword to be an allowed read-only keyword.
  const firstWordMatch = statement.match(/^[A-Za-z]+/);
  const firstWord = firstWordMatch ? firstWordMatch[0].toUpperCase() : "";

  if (!ALLOWED_LEADING_KEYWORDS.includes(firstWord)) {
    throw new Error(
      `Rejected: query must start with one of ${ALLOWED_LEADING_KEYWORDS.join(
        ", "
      )} (got "${firstWord || "<none>"}"). Only read-only queries are allowed.`
    );
  }

  // Defense-in-depth: reject if any forbidden DML/DDL keyword appears as a
  // whole word anywhere in the (comment-stripped) statement. Guards against
  // data-modifying CTEs and `SELECT ... INTO ...`. Dual-use function keywords
  // (REPLACE, MERGE) are deliberately excluded — see FORBIDDEN_ANYWHERE_KEYWORDS.
  for (const keyword of FORBIDDEN_ANYWHERE_KEYWORDS) {
    const re = new RegExp(`\\b${keyword}\\b`, "i");
    if (re.test(statement)) {
      throw new Error(
        `Rejected: forbidden keyword "${keyword}" detected. Only read-only queries are allowed.`
      );
    }
  }
}

/**
 * AST-based read-only check. Returns:
 *   - `true`  — parsed and every statement is read-only (allow).
 *   - `false` — parsed and at least one statement is a write/DDL/DCL, a
 *               `SELECT ... INTO`, or the AST was empty/unrecognized (reject).
 *   - `null`  — parsing threw or produced an unusable result; the caller must
 *               fall back to the regex verdict (so we never regress).
 */
function astReadOnlyVerdict(sql: string): boolean | null {
  let ast: unknown;
  try {
    // MySQL is the most permissive read-statement dialect here: it parses
    // EXPLAIN/SHOW/DESCRIBE/DESC into clean read-only node types, whereas
    // Postgres throws on EXPLAIN/DESCRIBE (which would just route those to the
    // regex fallback anyway — still safe, just less precise).
    const parser = new Parser();
    ast = parser.astify(sql, { database: "MySQL" });
  } catch {
    // Dialect quirk / unsupported syntax — let the regex fallback decide.
    return null;
  }

  const statements = Array.isArray(ast) ? ast : [ast];

  // An empty parse (e.g. comment-only or whitespace) is not something we can
  // confidently classify from the AST — defer to the regex verdict, which
  // already rejects empty/comment-only input.
  if (statements.length === 0) {
    return null;
  }

  // Reject stacked statements. Only a single read-only query is permitted —
  // matching the regex guard's long-standing single-statement rule. Multiple
  // statements are a classic injection vector (`SELECT 1; DROP TABLE x`), so we
  // refuse them even when every statement is itself a read.
  if (statements.length > 1) {
    return false;
  }

  return isReadOnlyStatement(statements[0]);
}

/**
 * True only if a single parsed statement node is read-only. A `select` node
 * carrying a non-null `into` target is `SELECT ... INTO new_table`, which
 * creates/writes a table and must be rejected.
 */
function isReadOnlyStatement(stmt: unknown): boolean {
  if (stmt === null || typeof stmt !== "object") {
    return false;
  }

  const node = stmt as { type?: unknown; into?: { expr?: unknown } | null };
  const type = typeof node.type === "string" ? node.type.toLowerCase() : "";

  if (!READ_ONLY_AST_TYPES.has(type)) {
    return false;
  }

  // `SELECT ... INTO target` writes data — reject despite the `select` type.
  if (node.into && node.into.expr != null) {
    return false;
  }

  return true;
}

/**
 * Throws an Error if `sql` is not a safe, single, read-only statement.
 * Returns void otherwise.
 *
 * Parser-first: when node-sql-parser can parse the SQL, the AST verdict is
 * authoritative (allows string-literal/parenthesized/UNION reads the regex
 * false-rejected). When parsing fails, falls back to the regex verdict so the
 * guard is never more restrictive than before on unparseable input.
 */
export function assertReadOnlySql(sql: string): void {
  if (typeof sql !== "string") {
    throw new Error("Rejected: SQL must be a string.");
  }

  const verdict = astReadOnlyVerdict(sql);

  if (verdict === true) {
    return; // AST confirms read-only.
  }

  if (verdict === false) {
    throw new Error(
      "Rejected: query is not read-only (a write/DDL/DCL or SELECT…INTO statement was detected). Only read-only queries are allowed."
    );
  }

  // verdict === null: parser could not classify the SQL — fall back to the
  // regex guard so we never regress on valid-but-exotic warehouse queries.
  assertReadOnlySqlRegex(sql);
}
