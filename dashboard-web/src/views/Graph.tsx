import { useMemo } from "react";
import type { Graph as GraphData } from "../api";

// Color per entity type (kept in sync with the legend in CompanyBrain).
export const TYPE_COLORS: Record<string, string> = {
  person: "#4f46e5",
  team: "#0891b2",
  project: "#16a34a",
  metric: "#d97706",
  product: "#db2777",
  customer: "#7c3aed",
  vendor: "#0d9488",
  other: "#6b7280",
};
const colorFor = (t: string) => TYPE_COLORS[t] ?? TYPE_COLORS.other;

const W = 760;
const H = 520;

interface Pos { x: number; y: number; }

/**
 * Tiny dependency-free force-directed layout (Fruchterman–Reingold). Nodes are
 * server-capped, so a fixed iteration count is cheap. Deterministic: seeded on a
 * circle (no Math.random) so the layout is stable across renders.
 */
function layout(data: GraphData): Pos[] {
  const n = data.nodes.length;
  if (n === 0) return [];
  const pos: Pos[] = data.nodes.map((_, i) => ({
    x: W / 2 + Math.cos((2 * Math.PI * i) / n) * Math.min(W, H) * 0.36,
    y: H / 2 + Math.sin((2 * Math.PI * i) / n) * Math.min(W, H) * 0.36,
  }));
  if (n === 1) return [{ x: W / 2, y: H / 2 }];
  const idx = new Map(data.nodes.map((node, i) => [node.id, i]));
  const k = Math.sqrt((W * H) / n) * 0.55;
  const iters = 240;
  for (let it = 0; it < iters; it++) {
    const disp: Pos[] = pos.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i].x - pos[j].x;
        let dy = pos[i].y - pos[j].y;
        let d = Math.hypot(dx, dy) || 0.01;
        const rep = (k * k) / d;
        dx /= d;
        dy /= d;
        disp[i].x += dx * rep; disp[i].y += dy * rep;
        disp[j].x -= dx * rep; disp[j].y -= dy * rep;
      }
    }
    for (const e of data.edges) {
      const a = idx.get(e.src);
      const b = idx.get(e.dst);
      if (a == null || b == null) continue;
      let dx = pos[a].x - pos[b].x;
      let dy = pos[a].y - pos[b].y;
      let d = Math.hypot(dx, dy) || 0.01;
      const att = (d * d) / k;
      dx /= d;
      dy /= d;
      disp[a].x -= dx * att; disp[a].y -= dy * att;
      disp[b].x += dx * att; disp[b].y += dy * att;
    }
    const temp = (1 - it / iters) * (Math.min(W, H) * 0.12);
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(disp[i].x, disp[i].y) || 0.01;
      const lim = Math.min(d, temp);
      pos[i].x = Math.max(24, Math.min(W - 24, pos[i].x + (disp[i].x / d) * lim));
      pos[i].y = Math.max(24, Math.min(H - 24, pos[i].y + (disp[i].y / d) * lim));
    }
  }
  return pos;
}

export function Graph({
  data,
  selectedId,
  onSelect,
}: {
  data: GraphData;
  selectedId?: number | null;
  onSelect: (id: number) => void;
}) {
  const pos = useMemo(() => layout(data), [data]);
  const idx = useMemo(() => new Map(data.nodes.map((n, i) => [n.id, i])), [data]);
  const maxFacts = Math.max(1, ...data.nodes.map((n) => n.factCount));

  return (
    <svg className="graph" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Entity relationship graph">
      {data.edges.map((e, i) => {
        const a = idx.get(e.src);
        const b = idx.get(e.dst);
        if (a == null || b == null) return null;
        return (
          <line
            key={i}
            x1={pos[a].x} y1={pos[a].y} x2={pos[b].x} y2={pos[b].y}
            stroke="#cbd5e1" strokeWidth={1}
            opacity={selectedId == null || e.src === selectedId || e.dst === selectedId ? 0.9 : 0.25}
          />
        );
      })}
      {data.nodes.map((node, i) => {
        const r = 6 + 10 * Math.sqrt(node.factCount / maxFacts);
        const active = node.id === selectedId;
        return (
          <g key={node.id} className="gnode" transform={`translate(${pos[i].x},${pos[i].y})`} onClick={() => onSelect(node.id)}>
            <circle r={r} fill={colorFor(node.type)} stroke={active ? "#111827" : "#fff"} strokeWidth={active ? 2.5 : 1.5} />
            <text x={r + 3} y={4} fontSize={11} fill="#374151">{node.name}</text>
          </g>
        );
      })}
    </svg>
  );
}
