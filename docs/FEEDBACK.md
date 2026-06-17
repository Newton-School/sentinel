# Feedback loop (👍/👎)

Sentinel captures feedback on its own replies as an online quality signal,
keyed to the request's `trace_id`, exposed as a Prometheus metric, and
harvestable into the answer-eval dataset.

There are two capture paths, both writing to the same `feedback` table:

- **Buttons (primary)** — every reply renders 👍 **Helpful** / 👎 **Not helpful**
  buttons. Clicking records the vote and swaps the buttons for a "thanks" note.
  One vote per user per reply (switching replaces it). Preferred: clear UX, and
  it needs only Slack **Interactivity**, not the `reactions:read` scope.
- **Reactions (secondary)** — a 👍/👎 reaction on a reply is also captured, if
  the `reaction_added` subscription + `reactions:read` scope are configured.

## How it works

1. When the bot posts a reply (feedback enabled), it renders the answer as
   Block Kit sections + an actions block with the two buttons; the request
   `trace_id` rides on each button's `value`. `recordReply` stores
   `(channel, reply_ts) → trace_id` plus the Q&A text in `bot_replies`.
2. A button click (`block_actions`) is acked, gated to allow-listed users,
   then `recordButtonFeedback` writes the vote (`reaction='button'`, latest
   wins) and the message is updated to confirm. A reaction goes through
   `recordFeedback` (classified from the emoji).
3. `sentinel_feedback_total{sentiment="positive|negative"}` is incremented and
   scraped at `/metrics`.
4. `npm run feedback:harvest` emits 👎'd Q&A pairs as `answers.jsonl` candidates
   for the eval harness.

## Slack setup

Feedback is a **default, always-on** feature — no env flag. Buttons render on
every reply out of the box. Two Slack-app settings make the capture functional:

- **For buttons (primary):** enable **Interactivity** in the Slack app. With
  Socket Mode this is just the toggle — no Request URL. Until it's on, the
  buttons render but a click won't reach the bot.
- **For reactions (optional):** add the `reaction_added` bot event subscription
  + the `reactions:read` scope.

If neither is configured, replies still render with buttons; the votes just
won't be captured until Interactivity is enabled.

## Harvesting feedback into evals

```bash
npm run feedback:harvest            # last 50 👎'd replies → JSONL on stdout
npm run feedback:harvest -- --limit 100
```

Review the emitted lines and append the good ones to
`evals/datasets/answers.jsonl`, then `npm run eval` scores them.
