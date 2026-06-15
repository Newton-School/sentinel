# Sentinel — Interactive Technical Explainer

A Vite + React + TypeScript app, styled with the **shadcn/ui** design system
(Tailwind v4 + Radix primitives), that explains the complete working of Sentinel:
the Q&A pipeline, the 9 MCP servers, the company-brain memory subsystem, the
Playwright Meet bot, the persona system, the SQLite data model, and ops/config.

## Run it

```bash
cd docs/explainer
npm install     # first time only
npm run dev     # http://localhost:5173
```

Or build a static bundle and preview it:

```bash
npm run build   # → dist/
npm run preview # http://localhost:4173
```

The built `dist/` is fully static (`base: "./"`), so you can also open
`dist/index.html` directly or host it anywhere.

## What's inside

- `src/data.ts` — all technical content (graph nodes, wires, MCP tools, brain
  constants, schema, env surface). The views are declarative renderers over this.
- `src/components/ArchitectureDiagram.tsx` — the interactive node graph: hand-positioned
  nodes, SVG wires computed from live DOM geometry, animated query-flow packets,
  and a shadcn `Sheet` drawer of per-node detail.
- `src/components/views.tsx` — the 8 tab views.
- `src/components/ui/*` — hand-authored shadcn/ui primitives (button, card, badge,
  tabs, accordion, sheet, separator, table).
- `src/index.css` — shadcn design tokens (light + dark) + subsystem accent palette.

> A zero-build single-file version also exists at `../sentinel-explainer.html`
> (no design system, opens directly in a browser).
