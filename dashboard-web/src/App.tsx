import { useState } from "react";
import { api } from "./api";
import { useAsync } from "./hooks";
import { Stat } from "./ui";
import { Conversations } from "./views/Conversations";
import { Feedback } from "./views/Feedback";
import { TraceDrawer } from "./views/TraceDrawer";

type Tab = "conversations" | "feedback";

function SummaryBar() {
  const { data } = useAsync(() => api.summary(), []);
  const pct = data?.positiveRatio != null ? `${Math.round(data.positiveRatio * 100)}%` : "—";
  return (
    <div className="summary">
      <Stat label="Questions answered" value={data ? data.totalQueries.toLocaleString() : "…"} />
      <Stat label="People served" value={data ? data.distinctUsers.toLocaleString() : "…"} />
      <Stat
        label="Satisfaction"
        value={pct}
        sub={data ? `👍 ${data.positiveCount} · 👎 ${data.negativeCount}` : undefined}
      />
      <Stat label="LLM cost" value={data ? `$${data.costUsd.toFixed(2)}` : "…"} />
    </div>
  );
}

function TraceLookup({ onOpen }: { onOpen: (id: string) => void }) {
  const [v, setV] = useState("");
  return (
    <form
      className="lookup"
      onSubmit={(e) => {
        e.preventDefault();
        const id = v.trim();
        if (id) onOpen(id);
      }}
    >
      <input className="input" placeholder="Open trace by id…" value={v} onChange={(e) => setV(e.target.value)} />
      <button className="btn" type="submit">Open</button>
    </form>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>("conversations");
  const [trace, setTrace] = useState<string | null>(null);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          <span className="brand-name">Sentinel</span>
          <span className="brand-sub">dashboard</span>
        </div>
        <TraceLookup onOpen={setTrace} />
      </header>

      <SummaryBar />

      <nav className="tabs">
        <button className={tab === "conversations" ? "tab tab-on" : "tab"} onClick={() => setTab("conversations")}>
          Conversations
        </button>
        <button className={tab === "feedback" ? "tab tab-on" : "tab"} onClick={() => setTab("feedback")}>
          👎 Triage
        </button>
        <a className="tab tab-link" href="https://github.com/Newton-School/sentinel/blob/main/grafana/sentinel-llmops-dashboard.json" target="_blank" rel="noreferrer">
          Ops metrics (Grafana) ↗
        </a>
      </nav>

      <main className="content">
        {tab === "conversations" ? <Conversations onOpenTrace={setTrace} /> : <Feedback onOpenTrace={setTrace} />}
      </main>

      {trace && <TraceDrawer traceId={trace} onClose={() => setTrace(null)} />}
    </div>
  );
}
