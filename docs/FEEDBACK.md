# Feedback loop (👍/👎)

Sentinel captures 👍/👎 reactions on its own replies as an online quality
signal. The signal lands in SQLite (keyed to the request's `trace_id`), is
exposed as a Prometheus metric, and 👎'd replies can be harvested into the
answer-eval dataset.

## How it works

1. When the bot posts a reply, `recordReply` stores `(channel, reply_ts) →
   trace_id` plus the question/answer text in the `bot_replies` table.
2. A `reaction_added` event on that reply is classified (`+1`/`thumbsup`/
   `white_check_mark` → positive; `-1`/`thumbsdown` → negative; anything else
   ignored) and written to the `feedback` table (deduped per
   user+reply+reaction). The bot's own reactions and non-allow-listed users are
   ignored.
3. `sentinel_feedback_total{sentiment="positive|negative"}` is incremented and
   scraped at `/metrics`.
4. `npm run feedback:harvest` emits 👎'd Q&A pairs as `answers.jsonl` candidates
   for the eval harness (PR #3).

## Enabling it (one-time Slack setup)

The code ships **off** behind `FEEDBACK_ENABLED`. Before turning it on, add to
the Slack app:

- **Event Subscriptions → Subscribe to bot events:** `reaction_added`
- **OAuth & Permissions → Bot Token Scopes:** `reactions:read` (the bot
  already has `reactions:write` for its progress reactions)

Then reinstall the app and set `FEEDBACK_ENABLED=1`. Until both are in place,
leave it `0` — the bot runs exactly as before.

## Harvesting feedback into evals

```bash
npm run feedback:harvest            # last 50 👎'd replies → JSONL on stdout
npm run feedback:harvest -- --limit 100
```

Review the emitted lines and append the good ones to
`evals/datasets/answers.jsonl`, then `npm run eval` scores them.
