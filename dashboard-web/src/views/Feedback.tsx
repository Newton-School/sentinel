import { api } from "../api";
import { useAsync } from "../hooks";
import { Money, RelTime, Spinner, ErrorMsg, Empty } from "../ui";

/**
 * The 👎 triage queue: every negatively-rated reply, newest first, with the
 * full failing answer and the trace's cost / reply-model / prompt version so
 * it can be read and routed to a fix. Clicking opens the trace drill-down.
 */
export function Feedback({ onOpenTrace }: { onOpenTrace: (traceId: string) => void }) {
  const { data, error, loading } = useAsync(() => api.negativeFeedback(100), []);

  return (
    <div>
      <p className="section-hint">
        Answers people marked 👎 — read what went wrong and open the trace to debug.
      </p>
      {loading && <Spinner />}
      {error && <ErrorMsg error={error} />}
      {data && data.items.length === 0 && <Empty label="No 👎 feedback — nothing to triage. 🎉" />}

      <div className="cards">
        {data?.items.map((f) => {
          const clickable = f.traceId != null;
          return (
            <article
              key={f.feedbackId}
              className={`card card-neg${clickable ? " card-click" : ""}`}
              onClick={() => clickable && onOpenTrace(f.traceId!)}
            >
              <div className="card-top">
                <span className="badge badge-neg">👎</span>
                {f.model && <span className="chip mono">{f.model}</span>}
                {f.promptVersion && <span className="chip mono">{f.promptVersion}</span>}
                <span className="chip"><Money usd={f.costUsd} /></span>
                <span className="muted small spacer">by {f.reactorUserId} · <RelTime iso={f.createdAt} /></span>
              </div>
              <p className="q">{f.question ?? <span className="muted">— question not recorded</span>}</p>
              <p className="a">{f.answer ?? <span className="muted">— answer not recorded</span>}</p>
              {clickable && <div className="card-cta">View trace →</div>}
            </article>
          );
        })}
      </div>
    </div>
  );
}
