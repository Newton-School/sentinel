import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

const metabaseFetchMock = vi.fn();
vi.mock("../src/mcp/metabaseClient.js", () => ({
  createMetabaseClient: vi.fn(() => ({ getSession: vi.fn(), metabaseFetch: metabaseFetchMock })),
}));
// No Metabase creds in config — so the no-creds path can be exercised.
vi.mock("../src/config.js", () => ({
  config: { METABASE_URL: undefined, METABASE_API_KEY: undefined },
}));

import { computeGroundTruth, formatDatasetResult, ALTIUS_DB_ID } from "../evals/groundTruth.js";

describe("formatDatasetResult", () => {
  it("returns a bare scalar for a single 1x1 result", () => {
    expect(formatDatasetResult({ data: { rows: [[12431]], cols: [{ name: "count" }] } }, 20)).toBe("12431");
  });

  it("returns header + rows for a small table", () => {
    const out = formatDatasetResult(
      { data: { rows: [["Lead", 100], ["Prospect", 50]], cols: [{ name: "stage" }, { name: "n" }] } },
      20
    );
    expect(out).toContain("stage | n");
    expect(out).toContain("Lead | 100");
    expect(out).toContain("Prospect | 50");
  });

  it("truncates large results to maxRows with a note", () => {
    const rows = Array.from({ length: 50 }, (_, i) => [`s${i}`, i]);
    const out = formatDatasetResult({ data: { rows, cols: [{ name: "s" }, { name: "n" }] } }, 5)!;
    expect(out).toContain("… (45 more rows)");
  });

  it("returns null on a failed query", () => {
    expect(formatDatasetResult({ status: "failed", error: "boom" }, 20)).toBeNull();
  });

  it("returns (no rows) when the result is empty", () => {
    expect(formatDatasetResult({ data: { rows: [], cols: [] } }, 20)).toBe("(no rows)");
  });
});

describe("computeGroundTruth", () => {
  beforeEach(() => metabaseFetchMock.mockReset());

  it("runs native SQL against Altius (db 29) and returns the formatted value", async () => {
    metabaseFetchMock.mockResolvedValue({ data: { rows: [[12431]], cols: [{ name: "count" }] } });
    const v = await computeGroundTruth("SELECT COUNT(*) FROM course_user_mapping", {
      url: "https://mb.test",
      apiKey: "k",
    });
    expect(v).toBe("12431");
    const [path, init] = metabaseFetchMock.mock.calls[0];
    expect(path).toBe("/api/dataset");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.database).toBe(ALTIUS_DB_ID);
    expect(body.type).toBe("native");
    expect(body.native.query).toContain("course_user_mapping");
  });

  it("returns null without credentials and never calls the API", async () => {
    const v = await computeGroundTruth("SELECT 1");
    expect(v).toBeNull();
    expect(metabaseFetchMock).not.toHaveBeenCalled();
  });

  it("returns null (never throws) when the query errors", async () => {
    metabaseFetchMock.mockRejectedValueOnce(new Error("boom"));
    await expect(
      computeGroundTruth("SELECT 1", { url: "https://mb.test", apiKey: "k" })
    ).resolves.toBeNull();
  });
});
