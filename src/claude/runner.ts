import { spawn } from "node:child_process";
import { config } from "../config.js";
import { createLogger } from "../logging/logger.js";
import { getMcpConfigPath, removeMcpConfig } from "./mcpConfig.js";
import type { ViewerScope } from "../access/scope.js";
import type { ClaudeResponse } from "../types/contracts.js";

const log = createLogger("claude-runner");

const TIMEOUT_MS = 120_000; // 2 minutes

/**
 * Telemetry parsed out of the CLI's `--output-format json` payload. Everything
 * is optional: a CLI format change must never break the response, so callers
 * fall back to raw stdout when this can't be extracted.
 */
interface ParsedClaudeOutput {
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  numTurns?: number;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Defensively parse `claude --print --output-format json` stdout.
 *
 * The payload is a single JSON object that (depending on CLI version) carries
 * the assistant text under `result` plus usage/cost telemetry
 * (`usage.input_tokens` / `usage.output_tokens`, `total_cost_usd`, `num_turns`,
 * `duration_ms`). Field names vary, so each is probed independently and any
 * failure (non-JSON, unexpected shape, missing fields) yields a sparse result —
 * the caller treats a missing `text` as "use raw stdout".
 */
export function parseClaudeJsonOutput(stdout: string): ParsedClaudeOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {};
  }

  if (!isObject(parsed)) return {};

  const out: ParsedClaudeOutput = {};

  // Assistant text. Newer CLIs use `result`; tolerate a couple of aliases.
  const text =
    typeof parsed.result === "string"
      ? parsed.result
      : typeof parsed.text === "string"
        ? parsed.text
        : undefined;
  if (text !== undefined) out.text = text;

  const usage = isObject(parsed.usage) ? parsed.usage : undefined;
  if (usage) {
    out.inputTokens = asNumber(usage.input_tokens);
    out.outputTokens = asNumber(usage.output_tokens);
  }

  out.costUsd = asNumber(parsed.total_cost_usd);
  out.numTurns = asNumber(parsed.num_turns);

  return out;
}

export async function runClaude(
  systemPrompt: string,
  userMessage: string,
  threadContext?: string,
  viewer?: ViewerScope
): Promise<ClaudeResponse> {
  const mcpConfigPath = getMcpConfigPath({ viewer });
  const start = Date.now();

  const fullPrompt = threadContext
    ? `${threadContext}\n\nLatest message:\n${userMessage}`
    : userMessage;

  const args = [
    "--print",
    fullPrompt,
    "--output-format",
    "json",
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
    // The Claude CLI authenticates via its own login (no ANTHROPIC_API_KEY);
    // it inherits the ambient env.
    const proc = spawn(config.CLAUDE_BIN, args, {
      env: process.env,
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
      // The CLI has exited, so it's done reading the config; remove this
      // spawn's per-request file so its plaintext credentials don't linger.
      removeMcpConfig(mcpConfigPath);
      const durationMs = Date.now() - start;

      if (code === 0) {
        const raw = stdout.trim();
        const parsed = parseClaudeJsonOutput(raw);

        // Safety fallback: if JSON parsing failed or the expected text field is
        // absent, use the raw stdout as the response text so a CLI format
        // change can never break replies. Telemetry stays unset in that case.
        const response: ClaudeResponse = {
          text: parsed.text ?? raw,
          durationMs,
        };
        if (parsed.inputTokens !== undefined) response.inputTokens = parsed.inputTokens;
        if (parsed.outputTokens !== undefined) response.outputTokens = parsed.outputTokens;
        if (parsed.costUsd !== undefined) response.costUsd = parsed.costUsd;
        if (parsed.numTurns !== undefined) response.numTurns = parsed.numTurns;

        log.info(
          {
            durationMs,
            responseLength: response.text.length,
            parsed: parsed.text !== undefined,
            inputTokens: response.inputTokens,
            outputTokens: response.outputTokens,
            costUsd: response.costUsd,
          },
          "Claude completed"
        );
        resolve(response);
      } else {
        log.error({ code, stderr, durationMs }, "Claude CLI failed");
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      // Spawn failed/errored; clean up this spawn's per-request config file.
      removeMcpConfig(mcpConfigPath);
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
