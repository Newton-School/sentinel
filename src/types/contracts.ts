export interface SlackEventEnvelope {
  type: "mention" | "dm" | "slash_command";
  userId: string;
  channelId: string;
  threadTs: string;
  text: string;
  messageTs: string;
}

export interface ThreadMessage {
  userId: string;
  text: string;
  ts: string;
}

export interface ClaudeResponse {
  /** Assistant text. From the CLI's JSON `result` field, or raw stdout on fallback. */
  text: string;
  /** Wall-clock duration measured by the runner (NOT the CLI-reported duration_ms). */
  durationMs: number;
  /** Prompt tokens, when the CLI's JSON telemetry was parsed. */
  inputTokens?: number;
  /** Completion tokens, when the CLI's JSON telemetry was parsed. */
  outputTokens?: number;
  /** Total cost in USD, when the CLI's JSON telemetry was parsed. */
  costUsd?: number;
  /** Number of agent turns, when the CLI's JSON telemetry was parsed. */
  numTurns?: number;
}
