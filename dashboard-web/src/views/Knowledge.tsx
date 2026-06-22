import { useState } from "react";
import { api } from "../api";
import { useAsync } from "../hooks";
import { RelTime, Spinner, ErrorMsg, Empty } from "../ui";

const CATEGORIES = ["decision", "fact", "owner", "deadline", "metric", "preference", "summary"];
const SOURCES = ["conversation", "meeting", "email", "manual"];

/** "What Sentinel learned" — the memory/facts browser with provenance. */
export function Knowledge() {
  const [category, setCategory] = useState("");
  const [sourceType, setSourceType] = useState("");
  const [search, setSearch] = useState("");

  const { data, error, loading } = useAsync(
    () => api.memories({ category: category || undefined, sourceType: sourceType || undefined, search: search || undefined, limit: 100 }),
    [category, sourceType, search]
  );

  return (
    <div>
      <p className="section-hint">Facts Sentinel captured from meetings, email and chat — newest first, with provenance.</p>
      <div className="filters">
        <input className="input" placeholder="Search facts…" value={search} onChange={(e) => setSearch(e.target.value.trim())} />
        <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="input" value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
          <option value="">All sources</option>
          {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {loading && <Spinner />}
      {error && <ErrorMsg error={error} />}
      {data && data.items.length === 0 && <Empty label="No facts match these filters." />}

      <div className="cards">
        {data?.items.map((m) => (
          <article key={m.id} className="card">
            <div className="card-top">
              <span className="chip">{m.category}</span>
              <span className="chip small">{m.sourceType}</span>
              {m.verified && <span className="badge badge-ok">verified</span>}
              <span className="muted small spacer">conf {Math.round(m.confidence * 100)}% · <RelTime iso={m.createdAt} /></span>
            </div>
            <p className="q">{m.text}</p>
            {m.entities.length > 0 && <div className="ent-tags">{m.entities.map((e, i) => <span key={i} className="chip small">{e}</span>)}</div>}
            {m.evidenceQuote && <blockquote className="evidence">“{m.evidenceQuote}”</blockquote>}
            <div className="muted small">{m.sourceLabel ?? m.sourceType}{m.speaker ? ` · ${m.speaker}` : ""}</div>
          </article>
        ))}
      </div>
    </div>
  );
}
