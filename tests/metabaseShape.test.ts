import { describe, it, expect } from "vitest";
import {
  shapeQueryResult,
  mapDashboards,
  mapDatabases,
} from "../src/mcp/metabaseShape.js";

describe("shapeQueryResult", () => {
  it("zips cols + rows into column-keyed objects", () => {
    const result = shapeQueryResult({
      cols: [{ name: "id" }, { name: "name" }, { name: "score" }],
      rows: [
        [1, "Alice", 90],
        [2, "Bob", 75],
      ],
    });
    expect(result).toEqual({
      columns: ["id", "name", "score"],
      rows: [
        { id: 1, name: "Alice", score: 90 },
        { id: 2, name: "Bob", score: 75 },
      ],
      rowCount: 2,
    });
  });

  it("returns empty rows + zero count when there are no rows", () => {
    const result = shapeQueryResult({
      cols: [{ name: "id" }],
      rows: [],
    });
    expect(result).toEqual({ columns: ["id"], rows: [], rowCount: 0 });
  });

  it("handles zero columns (empty objects per row)", () => {
    const result = shapeQueryResult({ cols: [], rows: [[], []] });
    expect(result.columns).toEqual([]);
    expect(result.rows).toEqual([{}, {}]);
    expect(result.rowCount).toBe(2);
  });

  it("preserves null cell values and does not drop them", () => {
    const result = shapeQueryResult({
      cols: [{ name: "a" }, { name: "b" }],
      rows: [[null, 0]],
    });
    expect(result.rows[0]).toEqual({ a: null, b: 0 });
    expect("a" in result.rows[0]).toBe(true);
  });

  it("aligns values positionally and ignores extra cells beyond cols", () => {
    // More cells than columns: extra trailing cells are simply not keyed.
    const result = shapeQueryResult({
      cols: [{ name: "x" }],
      rows: [["kept", "dropped"]],
    });
    expect(result.rows[0]).toEqual({ x: "kept" });
  });

  it("yields undefined for a column with no corresponding cell", () => {
    const result = shapeQueryResult({
      cols: [{ name: "x" }, { name: "y" }],
      rows: [["only-x"]],
    });
    expect(result.rows[0]).toEqual({ x: "only-x", y: undefined });
  });

  it("later duplicate column name overwrites the earlier value", () => {
    const result = shapeQueryResult({
      cols: [{ name: "dup" }, { name: "dup" }],
      rows: [["first", "second"]],
    });
    expect(result.rows[0]).toEqual({ dup: "second" });
  });
});

describe("mapDashboards", () => {
  it("projects to id/name/description and drops other fields", () => {
    const out = mapDashboards([
      { id: 1, name: "KPIs", description: "exec dash", extra: "x" } as any,
      { id: 2, name: "Funnel", description: null },
    ]);
    expect(out).toEqual([
      { id: 1, name: "KPIs", description: "exec dash" },
      { id: 2, name: "Funnel", description: null },
    ]);
  });

  it("returns [] for an empty list", () => {
    expect(mapDashboards([])).toEqual([]);
  });
});

describe("mapDatabases", () => {
  it("projects to id/name/engine", () => {
    const out = mapDatabases([
      { id: 1, name: "warehouse", engine: "postgres", details: {} } as any,
    ]);
    expect(out).toEqual([{ id: 1, name: "warehouse", engine: "postgres" }]);
  });

  it("returns [] for an empty list", () => {
    expect(mapDatabases([])).toEqual([]);
  });
});
