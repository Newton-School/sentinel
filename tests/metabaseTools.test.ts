import { describe, it, expect, vi } from "vitest";
import {
  runQuery,
  getQuestion,
  getCardSql,
  getDashboard,
  listDashboards,
  listDatabases,
} from "../src/mcp/metabaseTools.js";

/**
 * The tool functions take an injected `metabaseFetch` (the same signature as
 * MetabaseClient.metabaseFetch) so we can assert the EXACT path + HTTP method
 * each tool issues, independently of auth/transport. The `metabase_get_question`
 * method assertion is the regression test for the #testing-kpis 404 bug: the
 * saved-card run endpoint must be a POST, not a GET.
 */
function parseText(result: { content: { type: string; text: string }[] }): unknown {
  return JSON.parse(result.content[0].text);
}

describe("getQuestion (metabase_get_question)", () => {
  it("RUNS the saved card via POST /api/card/:id/query (regression: must not be GET)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ data: { cols: [{ name: "n" }], rows: [[1]] } });

    const result = await getQuestion(fetchMock, 10142);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, options] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/card/10142/query");
    expect(options?.method).toBe("POST");

    expect(parseText(result)).toEqual({
      columns: ["n"],
      rows: [{ n: 1 }],
      rowCount: 1,
    });
  });
});

describe("getCardSql (metabase_get_card_sql)", () => {
  it("fetches the card DEFINITION via GET /api/card/:id and returns its native SQL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      id: 10142,
      name: "talktime x movement",
      database_id: 29,
      dataset_query: {
        type: "native",
        database: 29,
        native: { query: "SELECT 1", "template-tags": {} },
      },
    });

    const result = await getCardSql(fetchMock, 10142);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, options] = fetchMock.mock.calls[0];
    // GET = no method override (or explicitly GET), and crucially NOT the /query path.
    expect(path).toBe("/api/card/10142");
    expect(options?.method ?? "GET").toBe("GET");

    expect(parseText(result)).toEqual({
      id: 10142,
      name: "talktime x movement",
      database_id: 29,
      query_type: "native",
      sql: "SELECT 1",
      parameters: [],
    });
  });
});

describe("getDashboard (metabase_get_dashboard)", () => {
  it("fetches a single dashboard via GET /api/dashboard/:id and enumerates its cards", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      id: 485,
      name: "MoM DS Funnel",
      description: null,
      tabs: [{ id: 198, name: "funnel" }],
      dashcards: [
        { id: 1, dashboard_tab_id: 198, card: { id: 9601, name: "assigned" } },
      ],
    });

    const result = await getDashboard(fetchMock, 485);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/dashboard/485");

    expect(parseText(result)).toEqual({
      id: 485,
      name: "MoM DS Funnel",
      description: null,
      tabs: [{ id: 198, name: "funnel" }],
      cards: [{ card_id: 9601, name: "assigned", tab_id: 198 }],
    });
  });
});

describe("runQuery (metabase_query)", () => {
  it("posts read-only SQL to /api/dataset and shapes the result", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ data: { cols: [{ name: "c" }], rows: [["x"]] } });

    const result = await runQuery(fetchMock, "SELECT c FROM t", 29);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, options] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/dataset");
    expect(options?.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({
      database: 29,
      type: "native",
      native: { query: "SELECT c FROM t" },
    });
    expect(parseText(result)).toEqual({ columns: ["c"], rows: [{ c: "x" }], rowCount: 1 });
  });

  it("rejects a non-read-only statement WITHOUT calling the warehouse", async () => {
    const fetchMock = vi.fn();
    const result = await runQuery(fetchMock, "DROP TABLE users", 29);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^Rejected:/);
  });

  it("allows a SELECT whose string literal contains a forbidden keyword (e.g. 'Call')", async () => {
    // Ties PR 1 to the PR 2 guard fix: this SQL must reach the warehouse, not be rejected.
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ data: { cols: [], rows: [] } });

    const result = await runQuery(
      fetchMock,
      "SELECT 1 FROM t WHERE event = 'Outbound Phone Call Activity'",
      29
    );

    expect(result.isError).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("listDashboards / listDatabases", () => {
  it("listDashboards hits GET /api/dashboard and projects id/name/description", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue([{ id: 485, name: "MoM DS Funnel", description: null, extra: 1 }]);

    const result = await listDashboards(fetchMock);

    expect(fetchMock.mock.calls[0][0]).toBe("/api/dashboard");
    expect(parseText(result)).toEqual([{ id: 485, name: "MoM DS Funnel", description: null }]);
  });

  it("listDatabases hits GET /api/database and projects id/name/engine", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ data: [{ id: 29, name: "Altius", engine: "postgres", x: 1 }] });

    const result = await listDatabases(fetchMock);

    expect(fetchMock.mock.calls[0][0]).toBe("/api/database");
    expect(parseText(result)).toEqual([{ id: 29, name: "Altius", engine: "postgres" }]);
  });
});
