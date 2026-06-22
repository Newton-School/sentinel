import { api } from "../api";
import { useAsync } from "../hooks";
import { RelTime, Spinner, ErrorMsg } from "../ui";
import { TYPE_COLORS } from "./Graph";

/** Dossier for one entity: profile, relationships, and the facts that back it. */
export function EntityDrawer({ id, onOpenEntity, onClose }: { id: number; onOpenEntity: (id: number) => void; onClose: () => void }) {
  const { data, error, loading } = useAsync(() => api.entity(id), [id]);

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Entity details">
        <header className="drawer-head">
          <div>
            <div className="drawer-eyebrow">Entity</div>
            {data && (
              <div className="ent-title">
                <span className="type-dot" style={{ background: TYPE_COLORS[data.entity.type] ?? TYPE_COLORS.other }} />
                <span className="ent-name">{data.entity.canonicalName}</span>
                <span className="chip">{data.entity.type}</span>
              </div>
            )}
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Close">✕</button>
        </header>

        {loading && <Spinner />}
        {error && <ErrorMsg error={error} />}

        {data && (
          <div className="drawer-body">
            {data.entity.aliases.length > 0 && (
              <div className="muted small">aka {data.entity.aliases.join(", ")}</div>
            )}

            {data.profileMd ? (
              <section>
                <h3 className="drawer-h">Dossier {data.builtAt && <span className="muted small">· built <RelTime iso={data.builtAt} /></span>}</h3>
                <pre className="dossier">{data.profileMd}</pre>
              </section>
            ) : (
              <p className="muted small">No dossier compiled yet ({data.entity.factCount} facts).</p>
            )}

            <section>
              <h3 className="drawer-h">Relationships <span className="muted small">({data.relationships.length})</span></h3>
              {data.relationships.length === 0 ? (
                <p className="muted small">None recorded.</p>
              ) : (
                <ul className="rel-list">
                  {data.relationships.map((r, i) => (
                    <li key={i}>
                      <span className="rel-verb">{r.direction === "out" ? r.relation : `${r.relation} (of)`}</span>
                      <button className="link" onClick={() => onOpenEntity(r.otherId)}>{r.otherName}</button>
                      <span className="chip small">{r.otherType}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 className="drawer-h">Backing facts <span className="muted small">({data.backingFacts.length})</span></h3>
              {data.backingFacts.length === 0 ? (
                <p className="muted small">No facts link to this entity.</p>
              ) : (
                <ul className="fact-list">
                  {data.backingFacts.map((f) => (
                    <li key={f.id}>
                      <span className="chip small">{f.category}</span>
                      <span>{f.text}</span>
                      <div className="muted small">{f.sourceLabel ?? f.sourceType}{f.speaker ? ` · ${f.speaker}` : ""} · <RelTime iso={f.createdAt} /></div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </aside>
    </>
  );
}
