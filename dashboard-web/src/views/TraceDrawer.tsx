import { api } from "../api";
import { useAsync } from "../hooks";
import { Money, RelTime, SentimentBadge, StatusBadge, Spinner, ErrorMsg } from "../ui";

/**
 * The single canonical inspector: reconstructs one Q&A from its trace_id —
 * the reply header + totals, the LLM-call timeline, and the feedback it got.
 * Opened from any row that references a reply (conversation card, 👎 queue).
 */
export function TraceDrawer({ traceId, onClose }: { traceId: string; onClose: () => void }) {
  const { data, error, loading } = useAsync(() => api.trace(traceId), [traceId]);

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Trace details">
        <header className="drawer-head">
          <div>
            <div className="drawer-eyebrow">Trace</div>
            <code className="drawer-trace-id">{traceId}</code>
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Close">✕</button>
        </header>

        {loading && <Spinner />}
        {error && <ErrorMsg error={error} />}

        {data && (
          <div className="drawer-body">
            {data.reply?.slackUrl && (
              <a className="slack-link" href={data.reply.slackUrl} target="_blank" rel="noreferrer">
                ↗ Open conversation in Slack
              </a>
            )}
            <section className="qa">
              <div className="qa-q">
                <span className="qa-tag">Q</span>
                <p>{data.reply?.question ?? <span className="muted">— question not recorded</span>}</p>
              </div>
              <div className="qa-a">
                <span className="qa-tag">A</span>
                <p>{data.reply?.answer ?? <span className="muted">— answer not recorded</span>}</p>
              </div>
            </section>

            <section className="totals">
              <div><span className="k">Cost</span><span className="v"><Money usd={data.totals.costUsd} /></span></div>
              <div><span className="k">Tokens</span><span className="v">{data.totals.inputTokens.toLocaleString()} in · {data.totals.outputTokens.toLocaleString()} out</span></div>
              <div><span className="k">Turns</span><span className="v">{data.totals.numTurns ?? "—"}</span></div>
              <div><span className="k">LLM calls</span><span className="v">{data.totals.callCount}</span></div>
              <div><span className="k">Latency</span><span className="v">{data.totals.latencyMs.toLocaleString()} ms</span></div>
              <div><span className="k">Prompt</span><span className="v">{data.totals.promptVersion ? <code>{data.totals.promptVersion}</code> : "—"}</span></div>
            </section>

            <section>
              <h3 className="drawer-h">Feedback</h3>
              {data.feedback.length === 0 ? (
                <p className="muted small">No 👍/👎 on this reply.</p>
              ) : (
                <ul className="fb-list">
                  {data.feedback.map((f, i) => (
                    <li key={i}>
                      <SentimentBadge sentiment={f.sentiment} />
                      <span className="muted small">{f.reaction} · by {f.reactorUserId} · <RelTime iso={f.createdAt} /></span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 className="drawer-h">LLM call timeline <span className="muted small">({data.calls.length})</span></h3>
              <div className="table-wrap">
                <table className="calls">
                  <thead>
                    <tr><th>op</th><th>model</th><th>tokens</th><th>cost</th><th>latency</th><th>status</th></tr>
                  </thead>
                  <tbody>
                    {data.calls.map((c) => (
                      <tr key={c.callId} className={c.status === "error" ? "row-err" : undefined}>
                        <td><span className="op">{c.operation}</span></td>
                        <td className="mono small">{c.model}</td>
                        <td className="mono small">{(c.inputTokens ?? 0)}/{(c.outputTokens ?? 0)}</td>
                        <td className="mono small"><Money usd={c.costUsd} /></td>
                        <td className="mono small">{c.latencyMs ?? "—"}{c.latencyMs != null ? " ms" : ""}</td>
                        <td><StatusBadge status={c.status} errorKind={c.errorKind} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}
      </aside>
    </>
  );
}
