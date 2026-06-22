import { api } from "../api";
import { useAsync } from "../hooks";
import { RelTime, Spinner, ErrorMsg, Empty } from "../ui";

function ageSeverity(iso: string): "ok" | "warn" | "stale" {
  const mins = (Date.now() - new Date(iso).getTime()) / 60000;
  if (mins < 30) return "ok";
  if (mins < 180) return "warn";
  return "stale";
}

/** SRE view: bot dependency health + the silent failure modes (stuck ingest
 *  cursor, meet-bot that stopped joining) + recent failed requests. */
export function Health({ onOpenTrace }: { onOpenTrace: (traceId: string) => void }) {
  const sys = useAsync(() => api.system(), []);
  const act = useAsync(() => api.activity(50), []);

  const bot = sys.data?.bot ?? null;
  const ready = bot && bot.slack === "connected" && bot.database === "connected";

  return (
    <div>
      <section className="health-block">
        <h3 className="drawer-h">Bot status</h3>
        {sys.loading && <Spinner />}
        {sys.error && <ErrorMsg error={sys.error} />}
        {sys.data && !bot && <Empty label="Bot status unknown (BOT_READY_URL not configured or bot unreachable)." />}
        {bot && (
          <>
            <div className={`status-banner ${ready ? "sb-ok" : "sb-bad"}`}>
              {ready ? "● Sentinel is live and answering" : "▲ Sentinel is degraded"}
              <span className="muted small">
                slack: {bot.slack ?? "?"} · db: {bot.database ?? "?"}
                {typeof bot.uptime === "number" ? ` · up ${Math.floor(bot.uptime / 3600)}h` : ""}
              </span>
            </div>
            <div className="mcp-grid">
              {(bot.mcpServers ?? []).map((s) => <span key={s} className="badge badge-ok">{s}</span>)}
              {(bot.unavailableSources ?? []).map((s) => <span key={s} className="badge badge-neg">{s} down</span>)}
            </div>
          </>
        )}
      </section>

      <section className="health-block">
        <h3 className="drawer-h">Ingest freshness</h3>
        {act.loading && <Spinner />}
        {act.data && act.data.cursors.length === 0 && <Empty label="No ingest cursors yet." />}
        <div className="freshness">
          {act.data?.cursors.map((c) => {
            const sev = ageSeverity(c.updatedAt);
            return (
              <div key={c.source} className={`fresh-card fresh-${sev}`}>
                <div className="fresh-src">{c.source}</div>
                <div className="fresh-age">last advanced <RelTime iso={c.updatedAt} /></div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="health-block">
        <h3 className="drawer-h">Meet-bot joins <span className="muted small">({act.data?.meetings.length ?? 0} recent)</span></h3>
        {act.data && act.data.meetings.length === 0 && <Empty label="No meetings joined recently." />}
        <ul className="join-list">
          {act.data?.meetings.slice(0, 10).map((m) => (
            <li key={m.eventId}><code className="mono small">{m.eventId}</code> <span className="muted small">{new Date(m.joinedAt).toLocaleString()}</span></li>
          ))}
        </ul>
      </section>

      <section className="health-block">
        <h3 className="drawer-h">Recent failed requests <span className="muted small">({act.data?.failedCalls.length ?? 0})</span></h3>
        {act.error && <ErrorMsg error={act.error} />}
        {act.data && act.data.failedCalls.length === 0 && <Empty label="No failed LLM calls. 🎉" />}
        <div className="table-wrap">
          {act.data && act.data.failedCalls.length > 0 && (
            <table className="calls">
              <thead><tr><th>when</th><th>op</th><th>error</th><th>model</th><th>question</th></tr></thead>
              <tbody>
                {act.data.failedCalls.map((f) => (
                  <tr key={f.callId} className="row-err row-click" onClick={() => onOpenTrace(f.traceId)}>
                    <td className="small"><RelTime iso={f.createdAt} /></td>
                    <td className="small">{f.operation}</td>
                    <td><span className="badge badge-neg">{f.errorKind ?? "error"}</span></td>
                    <td className="mono small">{f.model}</td>
                    <td className="small">{f.question ?? <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
