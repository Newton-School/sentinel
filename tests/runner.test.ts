import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// Mock pino so importing the logger doesn't try to write structured logs.
vi.mock("pino", () => {
  const noop = () => {};
  const logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    fatal: noop,
    trace: noop,
    child: () => logger,
  };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

// Avoid importing the real config module, whose top-level loadConfig()
// calls process.exit(1) when required env vars are missing. runner.ts only
// reads CLAUDE_BIN and ANTHROPIC_API_KEY.
vi.mock("../src/config.js", () => ({
  config: {
    CLAUDE_BIN: "claude-test-bin",
    ANTHROPIC_API_KEY: "sk-test-key",
  },
}));

// Avoid touching the filesystem in mcpConfig.getMcpConfigPath(); return a
// deterministic path so we can assert it shows up in the spawn args.
const MCP_CONFIG_PATH = "/tmp/test-mcp-config.json";
vi.mock("../src/claude/mcpConfig.js", () => ({
  getMcpConfigPath: vi.fn(() => MCP_CONFIG_PATH),
}));

// A controllable fake child process. It is an EventEmitter (so it can emit
// "close" / "exit" / "error") with stdout/stderr EventEmitters that can emit
// "data" with Buffers, plus a kill() spy.
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn((_signal?: string) => {
    this.killed = true;
    return true;
  });
  killed = false;
}

// Mock node:child_process with a spawn spy we control per-test.
const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

// Helper: flush pending microtasks/promise callbacks so that .then/.catch
// handlers attached inside runClaude run before we assert.
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("runClaude", () => {
  let child: FakeChild;

  beforeEach(() => {
    vi.clearAllMocks();
    child = new FakeChild();
    spawnMock.mockReturnValue(child);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("argument construction", () => {
    it("spawns the configured claude binary with the expected flags", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("SYSTEM PROMPT", "hello world");

      // Resolve so the promise doesn't dangle.
      child.emit("close", 0);
      await promise;

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [bin, args] = spawnMock.mock.calls[0];

      expect(bin).toBe("claude-test-bin");
      expect(args).toEqual([
        "--print",
        "hello world",
        "--output-format",
        "text",
        "--dangerously-skip-permissions",
        "--system-prompt",
        "SYSTEM PROMPT",
        "--mcp-config",
        MCP_CONFIG_PATH,
      ]);
    });

    it("passes the system prompt as the value after --system-prompt", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("my custom system prompt", "msg");
      child.emit("close", 0);
      await promise;

      const args = spawnMock.mock.calls[0][1] as string[];
      const idx = args.indexOf("--system-prompt");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe("my custom system prompt");
    });

    it("passes the mcp config path as the value after --mcp-config", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("sys", "msg");
      child.emit("close", 0);
      await promise;

      const args = spawnMock.mock.calls[0][1] as string[];
      const idx = args.indexOf("--mcp-config");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe(MCP_CONFIG_PATH);
    });

    it("spawns with ANTHROPIC_API_KEY injected into the child env", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("sys", "msg");
      child.emit("close", 0);
      await promise;

      const opts = spawnMock.mock.calls[0][2] as { env: Record<string, string> };
      expect(opts.env.ANTHROPIC_API_KEY).toBe("sk-test-key");
    });
  });

  describe("thread-context prefixing", () => {
    it("does NOT prefix the prompt when no thread context is given", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("sys", "just the message");
      child.emit("close", 0);
      await promise;

      const args = spawnMock.mock.calls[0][1] as string[];
      // value directly after --print is the prompt
      const idx = args.indexOf("--print");
      expect(args[idx + 1]).toBe("just the message");
    });

    it("prepends the thread context to the user message when provided", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("sys", "latest", "earlier thread history");
      child.emit("close", 0);
      await promise;

      const args = spawnMock.mock.calls[0][1] as string[];
      const idx = args.indexOf("--print");
      expect(args[idx + 1]).toBe(
        "earlier thread history\n\nLatest message:\nlatest"
      );
    });
  });

  describe("success path", () => {
    it("resolves to { text, durationMs } with trimmed collected stdout", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("sys", "msg");

      child.stdout.emit("data", Buffer.from("Hello "));
      child.stdout.emit("data", Buffer.from("world\n"));
      child.emit("close", 0);

      const result = await promise;
      expect(result.text).toBe("Hello world");
      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("ignores stderr content on a successful (code 0) exit", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("sys", "msg");
      child.stdout.emit("data", Buffer.from("the answer"));
      child.stderr.emit("data", Buffer.from("some warning"));
      child.emit("close", 0);

      const result = await promise;
      expect(result.text).toBe("the answer");
    });
  });

  describe("failure paths", () => {
    it("rejects when the process exits with a non-zero code, including stderr", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("sys", "msg");
      child.stderr.emit("data", Buffer.from("boom failure"));
      child.emit("close", 1);

      await expect(promise).rejects.toThrow(
        /Claude CLI exited with code 1: boom failure/
      );
    });

    it("rejects when spawn emits an error event", async () => {
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("sys", "msg");
      const spawnError = new Error("ENOENT: claude not found");
      child.emit("error", spawnError);

      await expect(promise).rejects.toThrow("ENOENT: claude not found");
    });
  });

  describe("timeout", () => {
    it("kills the child and rejects with a timeout error after ~120s", async () => {
      vi.useFakeTimers();
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("sys", "msg");
      // Attach a rejection handler immediately so the rejection isn't
      // treated as unhandled when timers fire.
      const assertion = expect(promise).rejects.toThrow(/timed out after 120000ms/);

      // Advance past the 120s timeout.
      vi.advanceTimersByTime(120_000);
      await flush();

      expect(child.kill).toHaveBeenCalledWith("SIGTERM");

      await assertion;
    });

    it("resolves before the timeout when the child closes early; the timer is not cleared (documents latent behavior)", async () => {
      // NOTE: runner.ts never clears the timeout timer on close. Once the
      // promise resolves on a successful "close", the resolve is permanent,
      // but the still-pending timer later fires and (because proc.killed is
      // false for a naturally-exited process) calls proc.kill("SIGTERM") on
      // the already-dead process and invokes reject() — a no-op on the
      // already-settled promise. This test documents that current behavior:
      // the resolved value wins, but kill() is still spuriously invoked.
      // A clearTimeout(timer) in the close/error handlers would fix this.
      vi.useFakeTimers();
      const { runClaude } = await import("../src/claude/runner.js");

      const promise = runClaude("sys", "msg");
      child.stdout.emit("data", Buffer.from("done"));
      child.emit("close", 0);

      const result = await promise;
      expect(result.text).toBe("done");

      // Before the timeout fires, kill has not been called.
      expect(child.kill).not.toHaveBeenCalled();

      // The timer is never cleared, so advancing past the timeout still
      // triggers a (spurious) kill on the already-exited process.
      vi.advanceTimersByTime(120_000);
      await flush();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");

      // The promise already resolved; the late reject() is a no-op.
      await expect(promise).resolves.toEqual(result);
    });
  });
});
