import { describe, it, expect } from "vitest";
import {
  shapeQueryResult,
  mapDashboards,
  mapDatabases,
  mapDashboardDetail,
  mapCardSql,
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

describe("mapDashboardDetail", () => {
  it("projects dashboard meta + tabs + the cards each tab holds", () => {
    const out = mapDashboardDetail({
      id: 528,
      name: "Input Dashboard",
      description: "the input dash",
      tabs: [
        { id: 288, name: "talktime-x-movement" },
        { id: 289, name: "other tab" },
      ],
      dashcards: [
        { id: 1, dashboard_tab_id: 288, card: { id: 10142, name: "talktime x movement" } },
        { id: 2, dashboard_tab_id: 289, card: { id: 10200, name: "other card" } },
      ],
    } as any);
    expect(out).toEqual({
      id: 528,
      name: "Input Dashboard",
      description: "the input dash",
      tabs: [
        { id: 288, name: "talktime-x-movement" },
        { id: 289, name: "other tab" },
      ],
      cards: [
        { card_id: 10142, name: "talktime x movement", tab_id: 288 },
        { card_id: 10200, name: "other card", tab_id: 289 },
      ],
    });
  });

  it("drops virtual/text dashcards that carry no card", () => {
    const out = mapDashboardDetail({
      id: 485,
      name: "MoM DS Funnel",
      description: null,
      dashcards: [
        { id: 1, dashboard_tab_id: null, card: { id: 9601, name: "funnel" } },
        // A text/heading card has no `card` object.
        { id: 2, dashboard_tab_id: null, card: null },
      ],
    } as any);
    expect(out).toEqual({
      id: 485,
      name: "MoM DS Funnel",
      description: null,
      tabs: [],
      cards: [{ card_id: 9601, name: "funnel", tab_id: null }],
    });
  });

  it("tolerates missing tabs/dashcards", () => {
    const out = mapDashboardDetail({ id: 1, name: "bare" } as any);
    expect(out).toEqual({ id: 1, name: "bare", description: null, tabs: [], cards: [] });
  });
});

describe("mapCardSql", () => {
  it("extracts native SQL, database id, and template-tag parameter names", () => {
    const out = mapCardSql({
      id: 10142,
      name: "talktime x movement",
      database_id: 29,
      dataset_query: {
        type: "native",
        database: 29,
        native: {
          query: "SELECT * FROM lsq_leads_x_activities_v2 WHERE course = {{course}}",
          "template-tags": {
            course: { name: "course", type: "text" },
            start_date: { name: "start_date", type: "date" },
          },
        },
      },
    } as any);
    expect(out).toEqual({
      id: 10142,
      name: "talktime x movement",
      database_id: 29,
      query_type: "native",
      sql: "SELECT * FROM lsq_leads_x_activities_v2 WHERE course = {{course}}",
      parameters: ["course", "start_date"],
    });
  });

  it("returns sql: null for an MBQL (non-native) card and falls back to dataset_query.database", () => {
    const out = mapCardSql({
      id: 9601,
      name: "mbql card",
      database_id: null,
      dataset_query: { type: "query", database: 29, query: { "source-table": 5 } },
    } as any);
    expect(out).toEqual({
      id: 9601,
      name: "mbql card",
      database_id: 29,
      query_type: "query",
      sql: null,
      parameters: [],
    });
  });

  it("tolerates a missing dataset_query", () => {
    const out = mapCardSql({ id: 7, name: "empty" } as any);
    expect(out).toEqual({
      id: 7,
      name: "empty",
      database_id: null,
      query_type: "unknown",
      sql: null,
      parameters: [],
    });
  });
});
