import { useState } from "react";
import { api } from "../api";
import { useAsync } from "../hooks";
import { Spinner, ErrorMsg, Empty } from "../ui";
import { Graph, TYPE_COLORS } from "./Graph";
import { EntityDrawer } from "./EntityDrawer";

const TYPES = ["person", "team", "project", "metric", "product", "customer", "vendor", "other"];

/** The company brain: an interactive entity graph + a searchable catalogue,
 *  both opening the same dossier drawer. */
export function CompanyBrain() {
  const [type, setType] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<number | null>(null);

  const graph = useAsync(() => api.graph({ types: type || undefined, nodeLimit: 60 }), [type]);
  const list = useAsync(() => api.entities({ type: type || undefined, search: search || undefined, limit: 100 }), [type, search]);

  return (
    <div className="brain">
      <div className="filters">
        <input className="input" placeholder="Search entities…" value={search} onChange={(e) => setSearch(e.target.value.trim())} />
        <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All types</option>
          {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      <div className="legend">
        {TYPES.map((t) => (
          <span key={t} className="legend-item"><span className="type-dot" style={{ background: TYPE_COLORS[t] }} />{t}</span>
        ))}
      </div>

      <div className="brain-grid">
        <div className="graph-wrap">
          {graph.loading && <Spinner />}
          {graph.error && <ErrorMsg error={graph.error} />}
          {graph.data && graph.data.nodes.length === 0 && <Empty label="No entities in the graph yet." />}
          {graph.data && graph.data.nodes.length > 0 && (
            <>
              <Graph data={graph.data} selectedId={selected} onSelect={setSelected} />
              {graph.data.capped && <div className="muted small">Showing the {graph.data.nodes.length} most-connected entities.</div>}
            </>
          )}
        </div>

        <div className="catalogue">
          <h3 className="drawer-h">Catalogue {list.data && <span className="muted small">({list.data.items.length})</span>}</h3>
          {list.loading && <Spinner />}
          {list.error && <ErrorMsg error={list.error} />}
          <ul className="ent-list">
            {list.data?.items.map((e) => (
              <li key={e.id} className={e.id === selected ? "ent-row ent-row-on" : "ent-row"} onClick={() => setSelected(e.id)}>
                <span className="type-dot" style={{ background: TYPE_COLORS[e.type] ?? TYPE_COLORS.other }} />
                <span className="ent-row-name">{e.canonicalName}</span>
                <span className="muted small spacer">{e.factCount} facts</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {selected != null && <EntityDrawer id={selected} onOpenEntity={setSelected} onClose={() => setSelected(null)} />}
    </div>
  );
}
