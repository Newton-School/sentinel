import { useState } from "react";
import { api, type Sentiment } from "../api";
import { useAsync } from "../hooks";
import { SentimentBadge, RelTime, Spinner, ErrorMsg, Empty } from "../ui";

/**
 * The readable Q&A feed. Each card is the real question + answer Sentinel
 * produced; clicking one opens the trace drill-down. Filter by asker and by
 * feedback sentiment.
 */
export function Conversations({ onOpenTrace }: { onOpenTrace: (traceId: string) => void }) {
  const [userId, setUserId] = useState("");
  const [sentiment, setSentiment] = useState<"" | Sentiment>("");

  const { data, error, loading } = useAsync(
    () => api.conversations({ userId: userId || undefined, sentiment: sentiment || undefined, limit: 50 }),
    [userId, sentiment]
  );

  return (
    <div>
      <div className="filters">
        <input
          className="input"
          placeholder="Filter by asker (Slack user id)…"
          value={userId}
          onChange={(e) => setUserId(e.target.value.trim())}
        />
        <select className="input" value={sentiment} onChange={(e) => setSentiment(e.target.value as "" | Sentiment)}>
          <option value="">All feedback</option>
          <option value="positive">👍 liked</option>
          <option value="negative">👎 disliked</option>
        </select>
      </div>

      {loading && <Spinner />}
      {error && <ErrorMsg error={error} />}
      {data && data.items.length === 0 && <Empty label="No conversations match these filters yet." />}

      <div className="cards">
        {data?.items.map((c) => {
          const clickable = c.traceId != null;
          return (
            <article
              key={`${c.channelId}/${c.replyTs}`}
              className={`card${clickable ? " card-click" : ""}`}
              onClick={() => clickable && onOpenTrace(c.traceId!)}
            >
              <div className="card-top">
                <span className="who">{c.displayName ?? c.userId ?? "unknown"}</span>
                <SentimentBadge sentiment={c.sentiment} />
                <span className="muted small spacer"><RelTime iso={c.createdAt} /></span>
              </div>
              <p className="q">{c.question ?? <span className="muted">— question not recorded</span>}</p>
              <p className="a">{c.answer ?? <span className="muted">— answer not recorded</span>}</p>
              {clickable && <div className="card-cta">View trace →</div>}
            </article>
          );
        })}
      </div>
    </div>
  );
}
