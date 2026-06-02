import { spawn } from "node:child_process";
import { config } from "../config.js";
import { createLogger } from "../logging/logger.js";
import { getMcpConfigPath } from "./mcpConfig.js";
import type { ClaudeResponse } from "../types/contracts.js";

const log = createLogger("claude-runner");

const TIMEOUT_MS = 120_000; // 2 minutes

export async function runClaude(
  systemPrompt: string,
  userMessage: string,
  threadContext?: string
): Promise<ClaudeResponse> {
  const mcpConfigPath = getMcpConfigPath();
  const start = Date.now();

  const fullPrompt = threadContext
    ? `${threadContext}\n\nLatest message:\n${userMessage}`
    : userMessage;

  const args = [
    "--print",
    fullPrompt,
    "--output-format",
    "text",
    "--dangerously-skip-permissions",
    "--system-prompt",
    systemPrompt,
    "--mcp-config",
    mcpConfigPath,
  ];

  log.info(
    { promptLength: fullPrompt.length, mcpConfig: mcpConfigPath },
    "Spawning Claude CLI"
  );

  return new Promise<ClaudeResponse>((resolve, reject) => {
    const env = { ...process.env };
    if (config.ANTHROPIC_API_KEY) {
      env.ANTHROPIC_API_KEY = config.ANTHROPIC_API_KEY;
    }

    const proc = spawn(config.CLAUDE_BIN, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: TIMEOUT_MS,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;

      if (code === 0) {
        log.info({ durationMs, responseLength: stdout.length }, "Claude completed");
        resolve({ text: stdout.trim(), durationMs });
      } else {
        log.error({ code, stderr, durationMs }, "Claude CLI failed");
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      log.error({ err, durationMs }, "Failed to spawn Claude CLI");
      reject(err);
    });

    // Timeout safety net. Cleared on close/error so it never fires after the
    // process has already settled (which would kill an exited PID and leave a
    // dangling timer holding the event loop open).
    const timer = setTimeout(() => {
      if (!proc.killed) {
        proc.kill("SIGTERM");
        reject(new Error(`Claude CLI timed out after ${TIMEOUT_MS}ms`));
      }
    }, TIMEOUT_MS);
  });
}
