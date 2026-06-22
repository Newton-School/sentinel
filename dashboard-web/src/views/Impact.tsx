import type { ImpactKpis, WeeklyPoint, Count } from "../api";
import { api } from "../api";
import { useAsync } from "../hooks";
import { Spinner, ErrorMsg, Empty } from "../ui";

const MINUTES_PER_QUERY = 12; // labeled estimate for the hours-saved figure

function Delta({ cur, prev, suffix = "" }: { cur: number; prev: number; suffix?: string }) {
  if (prev === 0) return cur > 0 ? <span className="delta up">new</span> : null;
  const pct = Math.round(((cur - prev) / prev) * 100);
  if (pct === 0) return <span className="delta flat">±0%</span>;
  return <span className={`delta ${pct > 0 ? "up" : "down"}`}>{pct > 0 ? "▲" : "▼"} {Math.abs(pct)}%{suffix}</span>;
}

function satisfaction(k: ImpactKpis): number | null {
  const t = k.positive + k.negative;
  return t > 0 ? k.positive / t : null;
}

function Trend({ weekly }: { weekly: WeeklyPoint[] }) {
  if (weekly.length === 0) return <Empty label="Not enough history yet for a trend." />;
  const max = Math.max(1, ...weekly.map((w) => w.queries));
  const W = 720, H = 160, pad = 24, bw = (W - pad * 2) / weekly.length;
  return (
    <svg className="trend" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Weekly usage and satisfaction">
      {weekly.map((w, i) => {
        const h = (w.queries / max) * (H - pad * 2);
        return <rect key={i} x={pad + i * bw + 4} y={H - pad - h} width={bw - 8} height={h} rx={3} fill="#c7d2fe" />;
      })}
      <polyline
        fill="none" stroke="#4f46e5" strokeWidth={2}
        points={weekly.map((w, i) => {
          const x = pad + i * bw + bw / 2;
          const y = H - pad - (w.positiveRatio ?? 0) * (H - pad * 2);
          return `${x},${y}`;
        }).join(" ")}
      />
      {weekly.map((w, i) => (
        <text key={i} x={pad + i * bw + bw / 2} y={H - 6} fontSize={9} fill="#9ca3af" textAnchor="middle">
          {w.weekStart.slice(5)}
        </text>
      ))}
    </svg>
  );
}

function Bars({ rows }: { rows: Count[] }) {
  if (rows.length === 0) return <Empty label="No data in window." />;
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="hbars">
      {rows.map((r) => (
        <div key={r.key} className="hbar">
          <span className="hbar-label">{r.key}</span>
          <div className="hbar-track"><div className="hbar-fill" style={{ width: `${(r.count / max) * 100}%` }} /></div>
          <span className="hbar-val">{r.count}</span>
        </div>
      ))}
    </div>
  );
}

/** Leadership-facing impact: ROI KPIs with deltas, an 8-week trend, and coverage. */
export function Impact() {
  const { data, error, loading } = useAsync(() => api.impact(), []);
  if (loading) return <Spinner />;
  if (error) return <ErrorMsg error={error} />;
  if (!data) return null;

  const { current: c, previous: p } = data;
  const hours = Math.round((c.queries * MINUTES_PER_QUERY) / 60);
  const prevHours = Math.round((p.queries * MINUTES_PER_QUERY) / 60);
  const sat = satisfaction(c);

  return (
    <div className="impact">
      <p className="section-hint">This month vs last month · coverage over the last 8 weeks.</p>
      <div className="hero">
        <div className="hero-card"><div className="hero-val">{c.queries.toLocaleString()}</div><div className="hero-lbl">Questions answered <Delta cur={c.queries} prev={p.queries} /></div></div>
        <div className="hero-card"><div className="hero-val">{c.users.toLocaleString()}</div><div className="hero-lbl">People served <Delta cur={c.users} prev={p.users} /></div></div>
        <div className="hero-card"><div className="hero-val">~{hours}h</div><div className="hero-lbl">Hours saved <span className="muted small">(est. {MINUTES_PER_QUERY}m/q)</span> <Delta cur={hours} prev={prevHours} /></div></div>
        <div className="hero-card"><div className="hero-val">{sat == null ? "—" : `${Math.round(sat * 100)}%`}</div><div className="hero-lbl">Satisfaction <span className="muted small">👍{c.positive}·👎{c.negative}</span></div></div>
        <div className="hero-card"><div className="hero-val">${c.costUsd.toFixed(2)}</div><div className="hero-lbl">LLM cost <Delta cur={c.costUsd} prev={p.costUsd} /></div></div>
      </div>

      <section className="impact-block">
        <h3 className="drawer-h">Usage & satisfaction (8 weeks)</h3>
        <Trend weekly={data.weekly} />
        <div className="muted small">Bars = questions/week · line = satisfaction.</div>
      </section>

      <div className="impact-grid">
        <section className="impact-block">
          <h3 className="drawer-h">Questions by business area</h3>
          <Bars rows={data.categories} />
        </section>
        <section className="impact-block">
          <h3 className="drawer-h">Data sources used</h3>
          <Bars rows={data.sources} />
        </section>
      </div>

      <section className="impact-block">
        <h3 className="drawer-h">Top users</h3>
        {data.topUsers.length === 0 ? <Empty label="No users in window." /> : (
          <ul className="ent-list">
            {data.topUsers.map((u) => (
              <li key={u.userId} className="ent-row">
                <span className="ent-row-name">{u.displayName ?? u.userId}</span>
                {u.role && <span className="chip small">{u.role}</span>}
                <span className="muted small spacer">{u.count} questions</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
