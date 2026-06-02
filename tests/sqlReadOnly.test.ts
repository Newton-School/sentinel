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
  });
});
