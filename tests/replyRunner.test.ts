import { describe, it, expect, vi, beforeEach } from "vitest";

// The dispatcher reads config.HARNESS at call time, so a mutable mock object
// lets us flip the selected backend per test without re-importing.
vi.mock("../src/config.js", () => ({ config: { HARNESS: "cli" } }));

// Both backends are mocked so the dispatcher test never spawns a CLI or hits
// OpenAI — we only assert which one is invoked and that args pass through.
const runClaudeMock = vi.fn();
const runAgentReplyMock = vi.fn();
vi.mock("../src/claude/runner.js", () => ({
  runClaude: (...a: unknown[]) => runClaudeMock(...a),
}));
vi.mock("../src/agent/runner.js", () => ({
  runAgentReply: (...a: unknown[]) => runAgentReplyMock(...a),
}));

import { config } from "../src/config.js";
import { runReply } from "../src/agent/replyRunner.js";

const setHarness = (h: string): void => {
  (config as unknown as { HARNESS: string }).HARNESS = h;
};

describe("runReply dispatcher", () => {
  beforeEach(() => {
    runClaudeMock.mockReset().mockResolvedValue({ text: "cli", durationMs: 1 });
    runAgentReplyMock.mockReset().mockResolvedValue({ text: "openai", durationMs: 1 });
  });

  it("routes to the Claude CLI runner when HARNESS=cli", async () => {
    setHarness("cli");
    const res = await runReply("sys", "msg", "ctx", undefined, "system@1.0.0", { model: "m" });
    expect(runClaudeMock).toHaveBeenCalledTimes(1);
    expect(runAgentReplyMock).not.toHaveBeenCalled();
    expect(res.text).toBe("cli");
  });

  it("routes to the OpenAI agent runner when HARNESS=openai", async () => {
    setHarness("openai");
    const res = await runReply("sys", "msg");
    expect(runAgentReplyMock).toHaveBeenCalledTimes(1);
    expect(runClaudeMock).not.toHaveBeenCalled();
    expect(res.text).toBe("openai");
  });

  it("forwards all positional args and options unchanged to the selected backend", async () => {
    setHarness("openai");
    const viewer = { userId: "U1" } as never;
    const opts = {
      model: "gpt-5.4-mini",
      mcpServers: new Set(["metabase"]),
      timeoutMs: 1000,
      maxTurns: 5,
    };
    await runReply("SYS", "MSG", "CTX", viewer, "system@1.0.0", opts);
    expect(runAgentReplyMock).toHaveBeenCalledWith(
      "SYS",
      "MSG",
      "CTX",
      viewer,
      "system@1.0.0",
      opts
    );
  });
});
