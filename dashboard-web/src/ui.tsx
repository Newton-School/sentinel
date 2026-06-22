import type { ReactNode } from "react";
import type { Sentiment } from "./api";

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {sub !== undefined && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function SentimentBadge({ sentiment }: { sentiment: Sentiment | null }) {
  if (sentiment === "positive") return <span className="badge badge-pos">👍 liked</span>;
  if (sentiment === "negative") return <span className="badge badge-neg">👎 disliked</span>;
  return <span className="badge badge-none">— no feedback</span>;
}

export function StatusBadge({ status, errorKind }: { status: string; errorKind?: string | null }) {
  if (status === "error") {
    return <span className="badge badge-neg">error{errorKind ? ` · ${errorKind}` : ""}</span>;
  }
  return <span className="badge badge-ok">ok</span>;
}

export function Money({ usd }: { usd: number | null }) {
  if (usd === null || usd === undefined) return <span className="muted">—</span>;
  // Sub-cent costs are common, so show enough precision to be useful.
  const s = usd >= 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(5)}`;
  return <span>{s}</span>;
}

export function RelTime({ iso }: { iso: string }) {
  const d = new Date(iso);
  const full = d.toLocaleString();
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60000);
  let rel: string;
  if (mins < 1) rel = "just now";
  else if (mins < 60) rel = `${mins}m ago`;
  else if (mins < 1440) rel = `${Math.round(mins / 60)}h ago`;
  else rel = `${Math.round(mins / 1440)}d ago`;
  return <time title={full}>{rel}</time>;
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return <div className="state-msg">{label}</div>;
}

export function ErrorMsg({ error }: { error: string }) {
  return <div className="state-msg state-err">Couldn’t load: {error}</div>;
}

export function Empty({ label }: { label: string }) {
  return <div className="state-msg muted">{label}</div>;
}
