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

/** The result of an agent reply run, mapped from the OpenAI Agents SDK result. */
export interface ReplyResponse {
  /** Assistant text (the agent run's final output). */
  text: string;
  /** Wall-clock duration measured by the runner. */
  durationMs: number;
  /** Prompt tokens across the run, when usage was reported. */
  inputTokens?: number;
  /** Completion tokens across the run, when usage was reported. */
  outputTokens?: number;
  /** Total cost in USD, computed from token usage. */
  costUsd?: number;
  /** Number of model requests/turns in the agent loop, when reported. */
  numTurns?: number;
}
