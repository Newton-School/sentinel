import { useState } from "react";
import { api } from "../api";
import { useAsync } from "../hooks";
import { RelTime, Spinner, ErrorMsg, Empty } from "../ui";

/** Personas — who uses Sentinel and the interests it has inferred for them. */
export function People() {
  const [selected, setSelected] = useState<string | null>(null);
  const list = useAsync(() => api.personas(100), []);
  const detail = useAsync(() => (selected ? api.persona(selected) : Promise.resolve(null)), [selected]);

  return (
    <div className="people-grid">
      <div>
        {list.loading && <Spinner />}
        {list.error && <ErrorMsg error={list.error} />}
        {list.data && list.data.items.length === 0 && <Empty label="No personas yet." />}
        <ul className="ent-list">
          {list.data?.items.map((p) => (
            <li key={p.userId} className={p.userId === selected ? "ent-row ent-row-on" : "ent-row"} onClick={() => setSelected(p.userId)}>
              <span className="ent-row-name">{p.displayName}</span>
              {p.role && <span className="chip small">{p.role}</span>}
              <span className="muted small spacer"><RelTime iso={p.updatedAt} /></span>
            </li>
          ))}
        </ul>
      </div>

      <div className="persona-detail">
        {!selected && <Empty label="Select a person to see their inferred interests." />}
        {selected && detail.loading && <Spinner />}
        {selected && detail.error && <ErrorMsg error={detail.error} />}
        {detail.data && (
          <>
            <h3 className="drawer-h">{detail.data.displayName}{detail.data.role ? ` · ${detail.data.role}` : ""}</h3>
            {detail.data.traits.length === 0 ? (
              <p className="muted small">No traits inferred yet.</p>
            ) : (
              <ul className="trait-list">
                {detail.data.traits.map((t, i) => (
                  <li key={i}>
                    <span className="chip">{t.label}</span>
                    <span className="trait-val">{t.value}</span>
                    <div className="bar"><div className="bar-fill" style={{ width: `${Math.round(t.confidence * 100)}%` }} /></div>
                    <span className="muted small">{Math.round(t.confidence * 100)}% · {t.evidenceCount}×</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
