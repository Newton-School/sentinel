import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the classifier so routing is deterministic and never hits OpenAI.
const classifyMock = vi.fn<[], Promise<"analytics" | "general">>();
vi.mock("../src/analytics/classifier.js", () => ({
  classifyAnalyticsIntent: (...args: unknown[]) => classifyMock(...(args as [])),
}));

import { decideRoute } from "../src/analytics/router.js";

describe("decideRoute", () => {
  beforeEach(() => {
    classifyMock.mockReset();
  });

  it("routes a classified-analytics question to the analytics agent", async () => {
    classifyMock.mockResolvedValue("analytics");
    expect(await decideRoute("how many enrollments last month?")).toEqual({ kind: "analytics" });
    expect(classifyMock).toHaveBeenCalledTimes(1);
  });

  it("routes everything else to the general bot", async () => {
    classifyMock.mockResolvedValue("general");
    expect(await decideRoute("what did we decide in standup?")).toEqual({ kind: "general" });
  });

  it("routes a projection request to analytics (no regex skill route anymore)", async () => {
    classifyMock.mockResolvedValue("analytics");
    expect(await decideRoute("Run open funnel projection for May")).toEqual({ kind: "analytics" });
    expect(classifyMock).toHaveBeenCalledTimes(1);
  });
});
