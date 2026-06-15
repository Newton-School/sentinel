import * as React from "react";
import { cn } from "@/lib/utils";

/** Renders our trusted HTML snippets (code/b/links) with .rich styling. */
export function Rich({
  html,
  className,
  as: As = "div",
}: {
  html: string;
  className?: string;
  as?: React.ElementType;
}) {
  return <As className={cn("rich", className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function SectionTitle({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h2 className={cn("mt-12 mb-5 flex items-center gap-2.5 text-lg font-semibold tracking-tight", className)}>
      <span className="h-5 w-1 rounded-full bg-primary" />
      {children}
    </h2>
  );
}

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
      {children}
    </div>
  );
}

export function CodeBlock({ children }: { children: string }) {
  return <pre className="code-block my-2">{children}</pre>;
}

export function NoteBox({
  children,
  kind = "info",
}: {
  children: React.ReactNode;
  kind?: "info" | "warn" | "ok";
}) {
  const color =
    kind === "warn" ? "var(--warn)" : kind === "ok" ? "var(--ok)" : "var(--primary)";
  return (
    <div
      className="my-3 rounded-r-lg border-l-2 py-2.5 pl-3.5 pr-3 text-[13px] text-muted-foreground"
      style={{ borderColor: color, background: `color-mix(in oklch, ${color} 7%, transparent)` }}
    >
      {children}
    </div>
  );
}

/** Numbered flow step (used across brain pipeline / meet / boot / shutdown). */
export function FlowList({
  steps,
  accent = "var(--primary)",
}: {
  steps: { n: string; title: string; desc: string }[];
  accent?: string;
}) {
  return (
    <div className="flex flex-col">
      {steps.map((s, i) => (
        <div key={i} className="flex gap-3.5">
          <div className="flex flex-col items-center">
            <div
              className="grid size-9 shrink-0 place-items-center rounded-xl border text-sm font-bold"
              style={{ color: accent, borderColor: `color-mix(in oklch, ${accent} 35%, transparent)`, background: `color-mix(in oklch, ${accent} 9%, transparent)` }}
            >
              {s.n}
            </div>
            {i < steps.length - 1 && (
              <div className="my-1 w-px flex-1" style={{ background: "var(--border)" }} />
            )}
          </div>
          <div className={cn("min-w-0 flex-1", i < steps.length - 1 && "pb-4")}>
            <div className="text-sm font-semibold">{s.title}</div>
            <Rich className="mt-0.5 text-[13px] text-muted-foreground" html={s.desc} />
          </div>
        </div>
      ))}
    </div>
  );
}
