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
 */

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
 * Throws an Error if `sql` is not a safe, single, read-only statement.
 * Returns void otherwise.
 */
export function assertReadOnlySql(sql: string): void {
  if (typeof sql !== "string") {
    throw new Error("Rejected: SQL must be a string.");
  }

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
