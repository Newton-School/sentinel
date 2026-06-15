import * as React from "react";
import { Play, RotateCcw, MousePointerClick } from "lucide-react";
import {
  GROUPS, NODES, WIRES, NODE_DETAIL, MCP, ACCENT_HEX,
  type GraphNode, type NodeDetail,
} from "@/data";
import { Button } from "@/components/ui/button";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Rich } from "@/components/bits";
import { cn } from "@/lib/utils";

interface WirePath { d: string; flow: boolean; id: string; }

const LEGEND: [string, string][] = [
  ["Slack", "slack"], ["Core", "core"], ["Claude CLI", "claude"],
  ["MCP", "mcp"], ["Brain", "brain"], ["Meet bot", "meet"], ["State", "data"],
];

export function ArchitectureDiagram() {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const nodeRefs = React.useRef<Record<string, HTMLDivElement | null>>({});
  const [wires, setWires] = React.useState<WirePath[]>([]);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);
  const [playToken, setPlayToken] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);

  const measure = React.useCallback(() => {
    const c = containerRef.current;
    if (!c) return;
    const cb = c.getBoundingClientRect();
    const out: WirePath[] = [];
    WIRES.forEach((w, i) => {
      const a = nodeRefs.current[w.from];
      const b = nodeRefs.current[w.to];
      if (!a || !b) return;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const A = { cx: ra.left - cb.left + ra.width / 2, cy: ra.top - cb.top + ra.height / 2, l: ra.left - cb.left, r: ra.right - cb.left, t: ra.top - cb.top, btm: ra.bottom - cb.top };
      const B = { cx: rb.left - cb.left + rb.width / 2, cy: rb.top - cb.top + rb.height / 2, l: rb.left - cb.left, r: rb.right - cb.left, t: rb.top - cb.top, btm: rb.bottom - cb.top };
      let x1 = A.cx, y1 = A.cy, x2 = B.cx, y2 = B.cy;
      const horizontal = Math.abs(B.cx - A.cx) > Math.abs(B.cy - A.cy);
      if (horizontal) {
        x1 = B.cx > A.cx ? A.r : A.l;
        x2 = B.cx > A.cx ? B.l : B.r;
      } else {
        y1 = B.cy > A.cy ? A.btm : A.t;
        y2 = B.cy > A.cy ? B.t : B.btm;
      }
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const d = horizontal
        ? `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`
        : `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
      out.push({ d, flow: !!w.flow, id: `wire-${i}` });
    });
    setWires(out);
  }, []);

  React.useLayoutEffect(() => {
    measure();
    const c = containerRef.current;
    if (!c) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(c);
    const t = setTimeout(() => { measure(); play(); }, 350);
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure]);

  function play() {
    setPlaying(true);
    setPlayToken((t) => t + 1);
    window.setTimeout(() => setPlaying(false), 4200);
  }

  function openNode(key: string) {
    setSelected(key);
    setOpen(true);
  }

  const detail = selected ? resolveDetail(selected) : null;
  const flowWires = wires.filter((w) => w.flow);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={play}>
          <Play /> Animate a query
        </Button>
        <Button size="sm" variant="outline" onClick={() => { setSelected(null); }}>
          <RotateCcw /> Reset
        </Button>
        <span className="ml-1 hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
          <MousePointerClick className="size-3.5" /> Click any node for technical detail
        </span>
        <div className="ml-auto flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
          {LEGEND.map(([label, key]) => (
            <span key={key} className="inline-flex items-center gap-1.5">
              <i className="size-2.5 rounded-[3px]" style={{ background: ACCENT_HEX[key as keyof typeof ACCENT_HEX] }} />
              {label}
            </span>
          ))}
        </div>
      </div>

      <div
        ref={containerRef}
        className="relative w-full overflow-hidden rounded-2xl border grid-bg"
        style={{ height: "clamp(820px, 78vw, 1180px)", background: "color-mix(in oklch, var(--card) 55%, var(--background))" }}
      >
        <svg className="pointer-events-none absolute inset-0 size-full" style={{ zIndex: 1 }}>
          <defs>
            <marker id="arw" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 Z" fill="var(--border)" />
            </marker>
          </defs>
          {wires.map((w) => (
            <path key={w.id} id={w.id} d={w.d} fill="none"
              stroke={w.flow ? "color-mix(in oklch, var(--core) 55%, var(--border))" : "var(--border)"}
              strokeWidth={w.flow ? 1.7 : 1.2} markerEnd="url(#arw)" />
          ))}
          {playing && (
            <g key={playToken}>
              {flowWires.map((w, i) => (
                <circle key={w.id} r="4.5" fill="var(--core)" className="flow-dot">
                  <animateMotion dur="0.9s" begin={`${i * 0.24}s`} repeatCount="1" rotate="auto" fill="freeze">
                    <mpath href={`#${w.id}`} />
                  </animateMotion>
                  <animate attributeName="opacity" values="0;1;1;0" dur="0.9s" begin={`${i * 0.24}s`} repeatCount="1" fill="freeze" />
                </circle>
              ))}
            </g>
          )}
        </svg>

        {GROUPS.map((g) => (
          <div key={g.id} className="absolute rounded-2xl border border-dashed"
            style={{ left: `${g.x}%`, top: `${g.y}%`, width: `${g.w}%`, height: `${g.h}%`, borderColor: "color-mix(in oklch, var(--border) 160%, transparent)", zIndex: 0 }}>
            <span className="absolute -top-2.5 left-4 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
              style={{ background: "color-mix(in oklch, var(--card) 55%, var(--background))" }}>
              {g.label}
            </span>
          </div>
        ))}

        {NODES.map((n) => (
          <NodeBox key={n.id} node={n} selected={selected === n.key}
            refCb={(el) => (nodeRefs.current[n.id] = el)} onClick={() => openNode(n.key)} />
        ))}
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent>
          {detail && (
            <>
              <SheetHeader>
                <Eyebrow text={detail.kicker} />
                <SheetTitle>{detail.title}</SheetTitle>
                <SheetDescription className="break-all font-mono">{detail.files}</SheetDescription>
              </SheetHeader>
              <div className="flex-1 overflow-y-auto p-6 pt-4">
                <DetailBody detail={detail} />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function Eyebrow({ text }: { text: string }) {
  return <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">{text}</div>;
}

const NodeBox = React.memo(function NodeBox({
  node, selected, refCb, onClick,
}: {
  node: GraphNode; selected: boolean;
  refCb: (el: HTMLDivElement | null) => void; onClick: () => void;
}) {
  const hex = ACCENT_HEX[node.accent];
  return (
    <button
      ref={refCb}
      onClick={onClick}
      className={cn(
        "group absolute z-[2] cursor-pointer rounded-xl border bg-card px-3 py-2 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-xl",
        selected && "z-[6] ring-2 ring-offset-2 ring-offset-background"
      )}
      style={{
        left: `${node.x}%`, top: `${node.y}%`, width: `${node.w}%`,
        borderLeft: `3px solid ${hex}`,
        ...(selected ? ({ "--tw-ring-color": hex } as React.CSSProperties) : {}),
      }}
    >
      <div className="flex items-center gap-2">
        <span className="grid size-[18px] shrink-0 place-items-center rounded-[5px] text-[11px]"
          style={{ background: `color-mix(in oklch, ${hex} 18%, transparent)` }}>
          {node.icon}
        </span>
        <span className="truncate text-[13px] font-semibold leading-tight">{node.title}</span>
      </div>
      <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{node.sub}</div>
    </button>
  );
});

/** Map a node key to a uniform NodeDetail (either explicit or derived from MCP). */
function resolveDetail(key: string): NodeDetail | null {
  if (NODE_DETAIL[key]) return NODE_DETAIL[key];
  if (key.startsWith("mcp-")) {
    const m = MCP.find((x) => `mcp-${x.id}` === key) || MCP.find((x) => key.includes(x.id.split("-")[0]));
    if (m) {
      return {
        kicker: "MCP server",
        title: m.name,
        files: m.file,
        body: [
          { p: `<b>Auth:</b> ${m.auth}` },
          { h: "Tools", list: m.tools },
          { note: m.note, noteKind: "info" },
        ],
      };
    }
  }
  return null;
}

function DetailBody({ detail }: { detail: NodeDetail }) {
  return (
    <div className="space-y-3">
      {detail.body.map((blk, i) => (
        <React.Fragment key={i}>
          {blk.h && <h4 className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{blk.h}</h4>}
          {blk.p && <Rich className="text-[13px] text-foreground/90" html={blk.p} />}
          {blk.list && (
            <ul className="space-y-1.5">
              {blk.list.map((li, j) => (
                <li key={j} className="flex gap-2 border-b border-border/60 pb-1.5 text-[13px] last:border-0">
                  <span className="mt-[3px] text-primary">▸</span>
                  <Rich html={li} className="flex-1" />
                </li>
              ))}
            </ul>
          )}
          {blk.code && <pre className="code-block">{blk.code}</pre>}
          {blk.note && (
            <div className="my-1 rounded-r-lg border-l-2 py-2.5 pl-3.5 pr-3 text-[13px]"
              style={{
                borderColor: blk.noteKind === "warn" ? "var(--warn)" : blk.noteKind === "ok" ? "var(--ok)" : "var(--primary)",
                background: `color-mix(in oklch, ${blk.noteKind === "warn" ? "var(--warn)" : blk.noteKind === "ok" ? "var(--ok)" : "var(--primary)"} 7%, transparent)`,
              }}>
              <Rich html={blk.note} className="text-muted-foreground" />
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}
