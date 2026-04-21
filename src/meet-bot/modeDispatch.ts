/**
 * Pure mode-dispatch logic for the Meet bot's post-join behavior.
 *
 * Three modes control whether the bot stays in the call for the full duration
 * or leaves after registering participation and enabling transcription:
 *
 * - leave-after-join (default): join → enable transcription → leave immediately.
 *   Saves a ton of memory; transcript is generated server-side by Google for the
 *   whole call and fetched later via the Meet REST API.
 *
 * - stay-until-end: legacy behavior. Bot stays in the call until it ends or
 *   the max duration hits. Useful when Sentinel needs in-call artifacts that
 *   require its presence (e.g., Meet chat, live reactions).
 *
 * - hybrid: try leave-after-join. If transcription can't be enabled, fall back
 *   to stay-until-end so Sentinel at least captures *something*.
 */

export type StayMode = "leave-after-join" | "stay-until-end" | "hybrid";
export type Action = "leave" | "stay";

const VALID_MODES: readonly StayMode[] = [
  "leave-after-join",
  "stay-until-end",
  "hybrid",
];

export function parseStayMode(input: string | undefined): StayMode {
  if (input === undefined) return "leave-after-join";
  if ((VALID_MODES as readonly string[]).includes(input)) {
    return input as StayMode;
  }
  throw new Error(
    `Invalid --stay-mode "${input}". Valid modes: ${VALID_MODES.join(", ")}`
  );
}

export function decideAction(mode: StayMode, transcriptionOn: boolean): Action {
  switch (mode) {
    case "leave-after-join":
      return "leave";
    case "stay-until-end":
      return "stay";
    case "hybrid":
      return transcriptionOn ? "leave" : "stay";
  }
}
