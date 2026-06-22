import { describe, it, expect } from "vitest";
import { assertReadOnlySql } from "../src/mcp/sqlReadOnly.js";

describe("assertReadOnlySql", () => {
  describe("allowed read-only queries", () => {
    it("allows a plain SELECT", () => {
      expect(() => assertReadOnlySql("SELECT * FROM users")).not.toThrow();
    });

    it("allows lowercase select", () => {
      expect(() => assertReadOnlySql("select id from users")).not.toThrow();
    });

    it("allows a WITH (CTE) query", () => {
      const sql = `WITH cte AS (SELECT id FROM users) SELECT * FROM cte`;
      expect(() => assertReadOnlySql(sql)).not.toThrow();
    });

    it("allows EXPLAIN SELECT", () => {
      expect(() =>
        assertReadOnlySql("EXPLAIN SELECT * FROM users")
      ).not.toThrow();
    });

    it("allows SHOW", () => {
      expect(() => assertReadOnlySql("SHOW TABLES")).not.toThrow();
    });

    it("allows DESCRIBE", () => {
      expect(() => assertReadOnlySql("DESCRIBE users")).not.toThrow();
    });

    it("allows DESC", () => {
      expect(() => assertReadOnlySql("DESC users")).not.toThrow();
    });

    it("does NOT reject SELECT referencing updated_at column", () => {
      expect(() =>
        assertReadOnlySql("SELECT id, updated_at FROM users")
      ).not.toThrow();
    });

    it("does NOT reject SELECT referencing created_at column", () => {
      expect(() =>
        assertReadOnlySql("SELECT created_at FROM users")
      ).not.toThrow();
    });

    it("does NOT reject SELECT referencing deleted_at column", () => {
      expect(() =>
        assertReadOnlySql(
          "SELECT deleted_at FROM users WHERE deleted_at IS NULL"
        )
      ).not.toThrow();
    });

    it("does NOT reject column names that merely contain forbidden substrings", () => {
      // create_date, insertion_count etc. — substring not whole word
      expect(() =>
        assertReadOnlySql(
          "SELECT create_date, insertion_count, droppable FROM events"
        )
      ).not.toThrow();
    });

    it("allows a query with line comments", () => {
      const sql = `-- get all users\nSELECT * FROM users -- trailing comment`;
      expect(() => assertReadOnlySql(sql)).not.toThrow();
    });

    it("allows a query with block comments", () => {
      const sql = `/* report query */ SELECT * FROM users /* end */`;
      expect(() => assertReadOnlySql(sql)).not.toThrow();
    });

    it("allows leading whitespace and newlines", () => {
      expect(() =>
        assertReadOnlySql("\n\n   \t SELECT * FROM users")
      ).not.toThrow();
    });

    it("allows a single trailing semicolon", () => {
      expect(() => assertReadOnlySql("SELECT * FROM users;")).not.toThrow();
    });

    it("allows a single trailing semicolon with whitespace after", () => {
      expect(() =>
        assertReadOnlySql("SELECT * FROM users;  \n")
      ).not.toThrow();
    });

    it("allows REPLACE() used as a read-side string function", () => {
      expect(() =>
        assertReadOnlySql("SELECT REPLACE(name, ' ', '_') AS slug FROM users")
      ).not.toThrow();
    });

    it("allows an alias/identifier named like a dual-use keyword (merge)", () => {
      expect(() =>
        assertReadOnlySql("SELECT id AS merge FROM users")
      ).not.toThrow();
    });

    // --- Cases the regex-only guard false-rejected, now allowed via the AST.
    // The AST ignores string-literal contents and parenthesized leading SELECTs,
    // so forbidden keywords that appear ONLY inside a string or as part of a
    // legitimate read no longer trip the guard.
    it("allows a forbidden keyword inside a string literal predicate (action = 'delete')", () => {
      expect(() =>
        assertReadOnlySql("SELECT id FROM events WHERE action = 'delete'")
      ).not.toThrow();
    });

    it("allows a multi-word forbidden phrase inside a string literal ('drop table x')", () => {
      expect(() =>
        assertReadOnlySql("SELECT * FROM t WHERE note = 'drop table x'")
      ).not.toThrow();
    });

    it("allows a parenthesized leading SELECT", () => {
      expect(() => assertReadOnlySql("(SELECT 1)")).not.toThrow();
    });

    it("allows a parenthesized UNION of two SELECTs", () => {
      expect(() =>
        assertReadOnlySql("(SELECT a FROM t) UNION (SELECT b FROM u)")
      ).not.toThrow();
    });
  });

  describe("parser-first / regex-fallback behavior", () => {
    // node-sql-parser (MySQL dialect) throws on some valid warehouse syntax —
    // e.g. a data-modifying CTE with RETURNING. When parsing throws we MUST fall
    // back to the regex verdict and never be more lenient than before. This
    // proves the fallback path runs AND still rejects an obvious write that the
    // parser couldn't model.
    it("falls back to the regex verdict and still rejects an unparseable write (WITH ... DELETE ... RETURNING)", () => {
      expect(() =>
        assertReadOnlySql(
          "WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x"
        )
      ).toThrow();
    });

    it("falls back to the regex verdict for MERGE INTO which the parser rejects", () => {
      expect(() =>
        assertReadOnlySql("MERGE INTO t USING s ON t.id = s.id")
      ).toThrow();
    });
  });

  describe("regex fallback ignores string-literal contents (#testing-kpis CALL bug)", () => {
    // These queries use Postgres-only syntax (FILTER, ILIKE) that the MySQL-
    // dialect parser cannot model, so they take the REGEX FALLBACK path — the
    // path that historically scanned forbidden keywords without ignoring string
    // literals. A forbidden keyword that appears ONLY inside a literal must not
    // false-reject these legitimate reads. The reported failure was a SELECT
    // rejected because "Call" appears inside 'Outbound Phone Call Activity'.
    it("allows COUNT(*) FILTER with an 'Outbound Phone Call Activity' literal (CALL inside a literal)", () => {
      expect(() =>
        assertReadOnlySql(
          "SELECT lead_id, COUNT(*) FILTER (WHERE activity_event_name = 'Outbound Phone Call Activity') AS c FROM t GROUP BY 1"
        )
      ).not.toThrow();
    });

    it("allows ILIKE against a literal containing 'Call'", () => {
      expect(() =>
        assertReadOnlySql(
          "SELECT 1 FROM t WHERE activity_event_name ILIKE '%Outbound Phone Call Activity%'"
        )
      ).not.toThrow();
    });

    it("allows literals containing other forbidden words ('create'/'drop') on the fallback path", () => {
      expect(() =>
        assertReadOnlySql(
          "SELECT 1 FROM t WHERE stage ILIKE '%create account%' OR note ILIKE '%drop off%'"
        )
      ).not.toThrow();
    });

    it("handles SQL doubled-quote escaping inside a fallback-path literal", () => {
      expect(() =>
        assertReadOnlySql(
          "SELECT 1 FROM t WHERE note = 'it''s a call we couldn''t make' AND x ILIKE '%y%'"
        )
      ).not.toThrow();
    });

    it("does NOT treat a semicolon inside a string literal as a statement separator", () => {
      // ILIKE forces the fallback; the '; DROP TABLE t' is inside a literal and
      // must not be split off as a second statement.
      expect(() =>
        assertReadOnlySql(
          "SELECT 1 FROM t WHERE note = 'a; DROP TABLE t' AND x ILIKE '%y%'"
        )
      ).not.toThrow();
    });

    // Regression guards: blanking literals must NOT weaken rejection of real
    // writes sitting OUTSIDE quotes on the fallback path.
    it("still rejects a real stacked write on the fallback path (ILIKE then ; DROP)", () => {
      expect(() =>
        assertReadOnlySql("SELECT 1 FROM t WHERE x ILIKE '%y%'; DROP TABLE t")
      ).toThrow();
    });

    it("still rejects a real forbidden keyword outside a literal on the fallback path", () => {
      expect(() =>
        assertReadOnlySql(
          "WITH x AS (DELETE FROM t WHERE note ILIKE '%keep%' RETURNING *) SELECT * FROM x"
        )
      ).toThrow();
    });
  });

  describe("rejected non-read-only queries", () => {
    it("rejects UPDATE", () => {
      expect(() =>
        assertReadOnlySql("UPDATE users SET name = 'x'")
      ).toThrow();
    });

    it("rejects DELETE", () => {
      expect(() => assertReadOnlySql("DELETE FROM users")).toThrow();
    });

    it("rejects DROP TABLE", () => {
      expect(() => assertReadOnlySql("DROP TABLE users")).toThrow();
    });

    it("rejects INSERT", () => {
      expect(() =>
        assertReadOnlySql("INSERT INTO users (id) VALUES (1)")
      ).toThrow();
    });

    it("rejects TRUNCATE", () => {
      expect(() => assertReadOnlySql("TRUNCATE users")).toThrow();
    });

    it("rejects ALTER", () => {
      expect(() =>
        assertReadOnlySql("ALTER TABLE users ADD COLUMN x INT")
      ).toThrow();
    });

    it("rejects CREATE", () => {
      expect(() =>
        assertReadOnlySql("CREATE TABLE x (id INT)")
      ).toThrow();
    });

    it("rejects MERGE", () => {
      expect(() =>
        assertReadOnlySql("MERGE INTO t USING s ON t.id = s.id")
      ).toThrow();
    });

    it("rejects GRANT", () => {
      expect(() =>
        assertReadOnlySql("GRANT ALL ON users TO bob")
      ).toThrow();
    });

    it("rejects a stacked statement SELECT 1; DROP TABLE x", () => {
      expect(() =>
        assertReadOnlySql("SELECT 1; DROP TABLE x")
      ).toThrow();
    });

    it("rejects a stacked SELECT; UPDATE even if both start with allowed keyword", () => {
      expect(() =>
        assertReadOnlySql("SELECT 1; SELECT 2")
      ).toThrow();
    });

    it("rejects SELECT ... INTO ...", () => {
      expect(() =>
        assertReadOnlySql("SELECT * INTO new_table FROM users")
      ).toThrow();
    });

    it("rejects empty string", () => {
      expect(() => assertReadOnlySql("")).toThrow();
    });

    it("rejects whitespace-only string", () => {
      expect(() => assertReadOnlySql("   \n\t  ")).toThrow();
    });

    it("rejects a comment-only string", () => {
      expect(() =>
        assertReadOnlySql("-- just a comment\n/* nothing */")
      ).toThrow();
    });

    it("rejects DML hidden behind a leading comment", () => {
      expect(() =>
        assertReadOnlySql("-- innocuous\nDELETE FROM users")
      ).toThrow();
    });

    it("rejects forbidden keyword appearing later (defense-in-depth)", () => {
      // First keyword is WITH (allowed) but a DROP appears later
      expect(() =>
        assertReadOnlySql(
          "WITH cte AS (SELECT 1) SELECT 1; DROP TABLE users"
        )
      ).toThrow();
    });

    it("throws an Error with a descriptive message", () => {
      expect(() => assertReadOnlySql("DELETE FROM users")).toThrow(/read-only|Rejected|forbidden|DELETE/i);
    });

    it("rejects REPLACE INTO as a statement starter (MySQL upsert)", () => {
      expect(() =>
        assertReadOnlySql("REPLACE INTO users (id) VALUES (1)")
      ).toThrow();
    });

    it("rejects MERGE INTO as a statement starter", () => {
      expect(() =>
        assertReadOnlySql("MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET t.x = s.x")
      ).toThrow();
    });

    it("rejects a data-modifying CTE (WITH ... DELETE ... RETURNING)", () => {
      expect(() =>
        assertReadOnlySql("WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x")
      ).toThrow();
    });
  });
});
