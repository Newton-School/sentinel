import * as React from "react";
import {
  Play, Pause, ChevronLeft, ChevronRight, KeyRound, ShieldCheck, Database,
} from "lucide-react";
import {
  STATS, GATES, LIFECYCLE, MCP, SEC_HIGHLIGHTS, BRAIN_FLOWS, BRAIN_PIPELINE,
  BRAIN_CONSTS, MEET_WATCH, MEET_JOIN, MEET_WHY, CATEGORIES, BOOT, SHUT, ENV,
  SCHEMA, ACCENT_HEX, type ErdTable,
} from "@/data";
import { ArchitectureDiagram } from "@/components/ArchitectureDiagram";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Accordion, AccordionItem, AccordionTrigger, AccordionContent,
} from "@/components/ui/accordion";
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from "@/components/ui/table";
import { Rich, SectionTitle, FlowList, NoteBox, CodeBlock } from "@/components/bits";
import { cn } from "@/lib/utils";

function PageHeader({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-7">
      <h1 className="mb-2 text-[26px] font-bold tracking-tight">{title}</h1>
      <p className="max-w-[940px] text-[15px] leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

/* ============================ OVERVIEW ============================ */
export function OverviewView() {
  return (
    <div className="fade-in">
      <PageHeader title="What is Sentinel, end to end?">
        Sentinel is a <b className="text-foreground">founders-only leadership/data assistant for Newton School</b>, delivered as a Slack bot.
        It is <b className="text-foreground">not</b> an LLM wrapped in a server — it is an orchestrator that spawns the{" "}
        <b className="text-foreground">Claude CLI</b> as a subprocess and hands it up to <b className="text-foreground">9 MCP tool servers</b> for live data.
        Two independent pipelines share one process: the <b className="text-foreground">Q&amp;A path</b> and the Playwright{" "}
        <b className="text-foreground">Meet-bot path</b>. Wrapped around both is a <b className="text-foreground">“company brain”</b> — a persistent
        organizational memory with an entity graph, hybrid retrieval, and provenance/ACL governance. Click any box to drill in.
      </PageHeader>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {STATS.map(([n, l]) => (
          <Card key={l} className="bg-gradient-to-b from-secondary/40 to-card">
            <CardContent className="p-4">
              <div className="bg-gradient-to-br from-foreground to-primary bg-clip-text text-2xl font-bold text-transparent">{n}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{l}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <ArchitectureDiagram />

      <SectionTitle>The two pipelines, in one sentence each</SectionTitle>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardContent className="p-5">
            <Badge style={{ color: ACCENT_HEX.core, background: `color-mix(in oklch, ${ACCENT_HEX.core} 14%, transparent)` }}>Q&amp;A PATH</Badge>
            <Rich className="mt-3 text-sm text-muted-foreground" html='A founder @mentions / DMs / <code>/sentinel</code>s the bot → <code>socketClient</code> authorizes &amp; de-dupes → <code>handleEvent</code> gathers thread context + persona + recalled memories → <code>buildSystemPrompt</code> assembles the prompt → <code>runClaude</code> spawns <code>claude --print</code> with an <code>--mcp-config</code> → Claude calls tools across the 9 MCP servers → the answer is reformatted to Slack mrkdwn and posted, with the exchange logged &amp; mined for new facts.' />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <Badge style={{ color: ACCENT_HEX.meet, background: `color-mix(in oklch, ${ACCENT_HEX.meet} 14%, transparent)` }}>MEET-BOT PATH</Badge>
            <Rich className="mt-3 text-sm text-muted-foreground" html='A calendar watcher polls every <b>60s</b> → eligible Meet events (starting within 2 min) spawn a <b>detached</b> Playwright Chrome subprocess → it joins muted using a persistent signed-in profile, clicks <i>Join/Ask-to-join</i>, and turns on Google’s <b>server-side transcription</b> → the transcript later becomes queryable via the Meet/Transcripts MCP servers and is ingested into the company brain.' />
          </CardContent>
        </Card>
      </div>

      <SectionTitle>Everything is gated &amp; inert by default</SectionTitle>
      <p className="mb-4 max-w-[900px] text-sm text-muted-foreground">
        Each MCP server only registers if its credentials are present. The company-brain’s advanced behavior (entity graph, embeddings,
        scoped ACLs, Slack ingestion) ships dark behind runtime kill-switches, so the blast radius is controlled. Defaults reflect a fresh deploy.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {GATES.map(([name, desc, state]) => (
          <Card key={name}>
            <CardContent className="flex flex-col gap-1.5 p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[13px] font-semibold">{name}</span>
                <Badge variant={state === "on" ? "success" : state === "off" ? "outline" : "warn"}>{state}</Badge>
              </div>
              <span className="text-xs text-muted-foreground">{desc}</span>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

/* ============================ LIFECYCLE ============================ */
export function LifecycleView() {
  const [idx, setIdx] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const timer = React.useRef<number | null>(null);
  const total = LIFECYCLE.length;

  const stop = React.useCallback(() => {
    if (timer.current) { window.clearInterval(timer.current); timer.current = null; }
    setPlaying(false);
  }, []);

  const go = React.useCallback((n: number) => {
    setIdx(Math.max(0, Math.min(total - 1, n)));
  }, [total]);

  React.useEffect(() => () => stop(), [stop]);

  function toggle() {
    if (playing) { stop(); return; }
    setPlaying(true);
    if (idx >= total - 1) setIdx(0);
    timer.current = window.setInterval(() => {
      setIdx((p) => { if (p >= total - 1) { stop(); return p; } return p + 1; });
    }, 2600);
  }

  const step = LIFECYCLE[idx];
  return (
    <div className="fade-in">
      <PageHeader title="Request lifecycle: a Slack message → an answer">
        Every inbound event flows through <code className="rich">handleEvent()</code> in <code className="rich">src/index.ts</code>, bounded by a
        3-request in-flight semaphore. Step through the exact sequence — or hit play to watch it run.
      </PageHeader>

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={toggle}>{playing ? <><Pause /> Pause</> : <><Play /> Auto-play</>}</Button>
        <Button size="sm" variant="outline" onClick={() => { go(idx - 1); stop(); }}><ChevronLeft /> Prev</Button>
        <Button size="sm" variant="outline" onClick={() => { go(idx + 1); stop(); }}>Next <ChevronRight /></Button>
        <span className="ml-1 text-xs text-muted-foreground">{idx + 1} of {total}</span>
      </div>

      <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
        <div className="flex flex-col gap-1.5">
          {LIFECYCLE.map((s, i) => (
            <button key={i} onClick={() => { go(i); stop(); }}
              className={cn(
                "flex items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-left transition-all hover:bg-accent/40",
                i === idx && "border-border bg-secondary/60"
              )}>
              <span className={cn(
                "grid size-7 shrink-0 place-items-center rounded-full border text-xs font-bold transition-colors",
                i === idx ? "bg-primary text-primary-foreground" : i < idx ? "border-[var(--ok)] bg-[var(--ok)] text-[#04210f]" : "text-muted-foreground"
              )}>{i + 1}</span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold">{s.head}</span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">{s.stage} · {s.file}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="lg:sticky lg:top-24 lg:self-start">
          <Card className="min-h-[400px]">
            <CardContent className="p-6">
              <div className="mb-4 h-1 overflow-hidden rounded-full bg-border">
                <div className="h-full rounded-full bg-gradient-to-r from-primary to-[var(--brain)] transition-all duration-500"
                  style={{ width: `${((idx + 1) / total) * 100}%` }} />
              </div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
                Step {idx + 1} / {total} · {step.stage}
              </div>
              <div className="mb-1 mt-1.5 text-2xl font-bold tracking-tight">{step.head}</div>
              <div className="font-mono text-[11px] text-muted-foreground">{step.file}</div>
              <Separator className="my-4" />
              <Rich className="text-[14px] leading-relaxed text-foreground/90" html={step.body} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

/* ============================ MCP ============================ */
export function McpView() {
  return (
    <div className="fade-in">
      <PageHeader title="The 9 MCP servers — Claude’s hands">
        For each Claude spawn, <code className="rich">mcpConfig.ts</code> writes a fresh <code className="rich">mcp-config-&lt;uuid&gt;.json</code> (mode{" "}
        <code className="rich">0600</code>, plaintext creds, deleted after the spawn). Each server is a stdio subprocess. Shared utilities give every HTTP
        server bounded <code className="rich">paginate()</code>, <code className="rich">fetchWithRetry()</code> (15s timeout, 3 retries, 429/5xx backoff,
        Retry-After aware), and <code className="rich">redactedHttpError()</code> (status only — never leaks bodies).
      </PageHeader>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {MCP.map((m) => {
          const hex = ACCENT_HEX[m.accent];
          return (
            <Card key={m.id} className="overflow-hidden">
              <div className="flex items-center gap-3 border-b bg-secondary/40 px-4 py-3">
                <span className="grid size-8 place-items-center rounded-lg text-base" style={{ background: `color-mix(in oklch, ${hex} 16%, transparent)` }}>{m.icon}</span>
                <div className="min-w-0">
                  <div className="truncate font-semibold">{m.name}</div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">{m.file}</div>
                </div>
              </div>
              <CardContent className="p-4">
                <Badge variant="outline" className="mb-2.5 border-border">{m.auth}</Badge>
                <div className="flex flex-col gap-1.5">
                  {m.tools.map((t, i) => {
                    const name = t.split("(")[0].split(" —")[0].trim();
                    return (
                      <div key={i} className="rounded-md border bg-background/60 px-2.5 py-1.5 font-mono text-[11.5px]">
                        <span style={{ color: hex }}>{name}</span>{t.slice(name.length)}
                      </div>
                    );
                  })}
                </div>
                <NoteBox>{m.note}</NoteBox>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <SectionTitle>Security &amp; correctness highlights</SectionTitle>
      <Accordion type="single" collapsible defaultValue="sec-0" className="grid gap-2.5">
        {SEC_HIGHLIGHTS.map((s, i) => (
          <AccordionItem key={i} value={`sec-${i}`}>
            <AccordionTrigger className="font-semibold text-foreground">
              <span className="flex items-center gap-2"><ShieldCheck className="size-4 text-[var(--ok)]" />{s.title}</span>
            </AccordionTrigger>
            <AccordionContent><Rich html={s.body} /></AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  );
}

/* ============================ BRAIN ============================ */
export function BrainView() {
  return (
    <div className="fade-in">
      <PageHeader title="The Company Brain — persistent organizational memory">
        Four cooperating flows turn fleeting conversations, meetings and emails into a governed, queryable knowledge base with an entity graph
        (people / teams / projects), hybrid lexical+semantic retrieval, and per-source confidence caps. All of it is evidence-grounded and fails
        safe — a memory error <b className="text-foreground">never</b> breaks a Slack reply.
      </PageHeader>

      <div className="grid gap-4 md:grid-cols-2">
        {BRAIN_FLOWS.map((f) => (
          <Card key={f.n} className="overflow-hidden">
            <div className="flex items-center gap-3 border-b bg-secondary/40 px-4 py-3">
              <span className="grid size-8 place-items-center rounded-lg text-sm font-bold" style={{ background: `color-mix(in oklch, ${ACCENT_HEX.brain} 16%, transparent)`, color: ACCENT_HEX.brain }}>{f.n}</span>
              <div>
                <div className="font-semibold">{f.title}</div>
                <div className="font-mono text-[11px] text-muted-foreground">{f.when}</div>
              </div>
            </div>
            <CardContent className="p-4"><Rich className="text-[13px] text-muted-foreground" html={f.body} /></CardContent>
          </Card>
        ))}
      </div>

      <SectionTitle>The full pipeline, top to bottom</SectionTitle>
      <Card><CardContent className="p-5"><FlowList steps={BRAIN_PIPELINE} accent={ACCENT_HEX.brain} /></CardContent></Card>

      <SectionTitle>Governance: every fact carries provenance &amp; policy</SectionTitle>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Provenance columns</CardTitle></CardHeader>
          <CardContent className="pt-0">
            <Kv rows={[
              ["source_type", "conversation · meeting · email · manual"],
              ["source_ref", "e.g. slack:C123:171…, gmail:&lt;id&gt;"],
              ["source_label", "human-readable origin"],
              ["speaker", "who asserted it (meetings)"],
              ["asserted_at", "when it was said"],
              ["evidence_quote", "verbatim substring proving the fact"],
            ]} />
            <div className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Confidence caps by source</div>
            <Kv rows={[["meeting", "0.70"], ["conversation / email", "0.60"], ["meeting summary", "0.60"], ["slack channel", "0.50 (noisiest)"]]} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Governance &amp; lifecycle</CardTitle></CardHeader>
          <CardContent className="pt-0">
            <Kv rows={[
              ["confidence", "per-source capped; grows on reinforcement"],
              ["verified", "human-confirmed flag"],
              ["visibility", "founders / leadership / team / public"],
              ["sensitivity", "normal / sensitive (HR/comp/legal)"],
              ["subject_entity_id", "the entity a fact is <i>about</i>"],
              ["status", "active / superseded / forgotten"],
              ["content_hash", "unique → dedup; + Jaccard ≥0.85 reinforce"],
            ]} />
            <NoteBox kind="ok">ACL seam <code>canView()</code> runs at <b>both</b> recall edges. Mode <code>founders</code> (default): founders see all, nobody else sees anything. Mode <code>scoped</code> (built, dormant): tier + per-team checks.</NoteBox>
          </CardContent>
        </Card>
      </div>

      <SectionTitle>Key tuning constants</SectionTitle>
      <Table>
        <TableHeader><TableRow><TableHead>Constant</TableHead><TableHead>Value</TableHead><TableHead>Where</TableHead><TableHead>Purpose</TableHead></TableRow></TableHeader>
        <TableBody>
          {BRAIN_CONSTS.map((r, i) => (
            <TableRow key={i}>
              <TableCell className="font-medium">{r[0]}</TableCell>
              <TableCell className="font-mono text-[12px] text-primary">{r[1]}</TableCell>
              <TableCell className="font-mono text-[12px] text-muted-foreground">{r[2]}</TableCell>
              <TableCell className="text-muted-foreground">{r[3]}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function Kv({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1.5 text-[13px]">
      {rows.map(([k, v], i) => (
        <React.Fragment key={i}>
          <dt className="font-mono text-muted-foreground">{k}</dt>
          <Rich as="dd" html={v} className="text-foreground/90" />
        </React.Fragment>
      ))}
    </dl>
  );
}

/* ============================ MEET ============================ */
export function MeetView() {
  return (
    <div className="fade-in">
      <PageHeader title="Meet bot — the Playwright auto-join pipeline">
        A completely separate pipeline whose only job is to make transcripts <i>exist</i>. Google only generates a transcript if a real participant
        turns it on, so Sentinel sends a headless Chrome bot to do exactly that. It shares the process and Google OAuth creds with the Q&amp;A path,
        but runs independently.
      </PageHeader>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Watcher · meet-bot/watcher.ts</CardTitle></CardHeader>
          <CardContent><FlowList steps={MEET_WATCH} accent={ACCENT_HEX.meet} /></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Joiner · meet-bot/joiner.ts (detached Chrome)</CardTitle></CardHeader>
          <CardContent><FlowList steps={MEET_JOIN} accent={ACCENT_HEX.meet} /></CardContent>
        </Card>
      </div>

      <SectionTitle>Why these design choices</SectionTitle>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {MEET_WHY.map(([title, body]) => (
          <Card key={title}><CardContent className="p-4">
            <div className="text-sm font-semibold">{title}</div>
            <Rich className="mt-1.5 text-[13px] text-muted-foreground" html={body} />
          </CardContent></Card>
        ))}
      </div>
    </div>
  );
}

/* ============================ PERSONA ============================ */
export function PersonaView() {
  return (
    <div className="fade-in">
      <PageHeader title="Persona system — per-user personalization that decays">
        SQLite-backed, learned implicitly from query patterns. Every interaction is categorized, logged, and used to reinforce a{" "}
        <code className="rich">focus_area</code> trait whose confidence <b className="text-foreground">grows on reinforcement</b> and{" "}
        <b className="text-foreground">decays at read time</b> — so stale interests fade without ever mutating stored rows.
      </PageHeader>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">Confidence math · store.ts · personaDecay.ts</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <Rich html="A new trait starts at <b>0.5</b>. Each reinforcement (same user+label+value) closes 15% of the gap to the 0.95 ceiling via an <code>ON CONFLICT DO UPDATE</code> upsert:" />
            <CodeBlock>{`confidence = MIN(c + (1 - c) * 0.15, 0.95)\n0.50 → 0.575 → 0.609 → 0.633 → … → 0.95 (limit)`}</CodeBlock>
            <Rich html="At <b>read time only</b>, confidence is decayed by a 30-day half-life based on <code>updated_at</code>:" />
            <CodeBlock>{`decayed = confidence * 0.5 ^ (ageDays / 30)`}</CodeBlock>
            <Rich html="<code>buildSystemPrompt</code> keeps only traits ≥0.6 decayed confidence, sorts by it, and caps to the <b>top 8</b> to bound prompt growth." />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm uppercase tracking-wide text-muted-foreground">The 7 query categories · tracker.ts</CardTitle></CardHeader>
          <CardContent>
            <Rich className="mb-3 text-sm text-muted-foreground" html="<code>categorizeQuery()</code> lowercases the text, counts keyword hits per bucket, and returns the top bucket (or <code>general</code>). A non-general category reinforces <code>upsertTrait(user, &quot;focus_area&quot;, category)</code>." />
            <div className="flex flex-col">
              {CATEGORIES.map(([cat, kw]) => (
                <div key={cat} className="flex items-center gap-3 border-b border-border/60 py-2 last:border-0">
                  <Badge className="shrink-0 font-mono">{cat}</Badge>
                  <span className="text-[13px] text-muted-foreground">{kw}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
      <NoteBox>Every interaction is also written to <code>query_log</code> (an append-only audit trail with response text, duration &amp; sources) — pruned to ~90 days, indexed on user &amp; time.</NoteBox>
    </div>
  );
}

/* ============================ DATA ============================ */
export function DataView() {
  return (
    <div className="fade-in">
      <PageHeader title="Data model — one SQLite file, 13 tables">
        <code className="rich">sentinel.db</code> (WAL mode, foreign keys, <code className="rich">busy_timeout=5000</code>) opened lazily as a single
        <code className="rich"> better-sqlite3</code> connection in the main process. Idempotent migrations run once on first <code className="rich">getDb()</code>;
        the memory MCP server opens its own read handle and never migrates. Retention sweeps run once at boot (query log &amp; non-active memories → 90 days).
      </PageHeader>

      <ErdGroup title="Persona & audit" tables={SCHEMA.persona} />
      <ErdGroup title="Company brain — facts" tables={SCHEMA.facts} />
      <ErdGroup title="Company brain — entity graph" tables={SCHEMA.graph} />
      <ErdGroup title="Meet bot" tables={SCHEMA.meet} />
    </div>
  );
}

function ErdGroup({ title, tables }: { title: string; tables: ErdTable[] }) {
  return (
    <div className="mb-2">
      <div className="mb-3 mt-7 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{title}</div>
      <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {tables.map((t) => (
          <Card key={t.name} className="overflow-hidden">
            <div className="flex items-center justify-between gap-2 border-b bg-secondary/40 px-3 py-2">
              <span className="font-mono text-[13px] font-bold" style={{ color: ACCENT_HEX.data }}>{t.name}</span>
              <span className="text-[10px] text-muted-foreground">{t.note}</span>
            </div>
            <div className="px-1 py-1">
              {t.rows.map((r, i) => (
                <div key={i} className="flex items-center justify-between gap-2 border-b border-border/40 px-2.5 py-[5px] font-mono text-[11.5px] last:border-0">
                  <span className="text-foreground/90">
                    {r[0]}
                    {r[2] === "pk" && <span className="ml-1 text-[9px] text-[var(--warn)]">PK</span>}
                    {r[2] === "fk" && <span className="ml-1 text-[9px] text-[var(--brain)]">FK</span>}
                    {r[2] === "uq" && <span className="ml-1 text-[9px] text-[var(--ok)]">UQ</span>}
                  </span>
                  <span className="text-muted-foreground/70">{r[1]}</span>
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

/* ============================ OPS ============================ */
export function OpsView() {
  return (
    <div className="fade-in">
      <PageHeader title="Operations, config & deployment">
        Process bootstrap, health/readiness, metrics, graceful shutdown, and the full env surface validated by Zod at boot (invalid config →{" "}
        <code className="rich">process.exit(1)</code>).
      </PageHeader>

      <SectionTitle>Bootstrap order · main() in index.ts</SectionTitle>
      <Card><CardContent className="p-5"><FlowList steps={BOOT} /></CardContent></Card>

      <SectionTitle>Health endpoints · health/server.ts · port 8930</SectionTitle>
      <div className="grid gap-3 md:grid-cols-3">
        <HealthCard variant="success" path="GET /health" title="Liveness" body="Always 200 {status:&quot;alive&quot;,uptime}. Deliberately decoupled from Slack/DB so a transient blip can't trigger a K8s restart loop." />
        <HealthCard variant="warn" path="GET /ready" title="Readiness" body="200 only when Slack is connected AND a DB SELECT 1 passes; else 503 with Slack/DB status, active MCP servers, unavailable sources." />
        <HealthCard variant="default" path="GET /metrics" title="Prometheus" body="Request count/duration/tokens/cost (parsed from the CLI's JSON telemetry) + sentinel_memory_* counters." />
      </div>

      <SectionTitle>Graceful shutdown · shutdown.ts</SectionTitle>
      <Card><CardContent className="p-5"><FlowList steps={SHUT} /></CardContent></Card>

      <SectionTitle>Environment surface · config.ts</SectionTitle>
      <Table>
        <TableHeader><TableRow><TableHead>Variable</TableHead><TableHead>Required</TableHead><TableHead>Default</TableHead><TableHead>Notes</TableHead></TableRow></TableHeader>
        <TableBody>
          {ENV.map((r, i) => (
            <TableRow key={i}>
              <TableCell className="font-mono text-[12px]">{r[0]}</TableCell>
              <TableCell>{r[1] ? <span className="text-[var(--ok)]">required</span> : <span className="text-muted-foreground">optional</span>}</TableCell>
              <TableCell className="font-mono text-[12px]">{r[2]}</TableCell>
              <TableCell className="text-[13px] text-muted-foreground">{r[3]}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <SectionTitle>Deployment</SectionTitle>
      <div className="grid gap-3 md:grid-cols-3">
        <Card><CardContent className="p-4"><div className="mb-1.5 flex items-center gap-2 font-semibold"><Database className="size-4 text-muted-foreground" />Docker</div><p className="text-[13px] text-muted-foreground">Two-stage: node:20-alpine builds dist/; runtime is the Playwright jammy image with Chrome so the Meet bot can launch. Drops to non-root pwuser. EXPOSE 8930, curl HEALTHCHECK.</p></CardContent></Card>
        <Card><CardContent className="p-4"><div className="mb-1.5 flex items-center gap-2 font-semibold"><KeyRound className="size-4 text-muted-foreground" />CI/CD — AWS CodeBuild</div><p className="text-[13px] text-muted-foreground">npm ci → build → test → ECR login → build/push (SHA + latest) → emit imageDetail.json + package k8s/**.</p></CardContent></Card>
        <Card><CardContent className="p-4"><div className="mb-1.5 flex items-center gap-2 font-semibold"><ShieldCheck className="size-4 text-muted-foreground" />Kubernetes</div><p className="text-[13px] text-muted-foreground">1 replica, Recreate strategy, RWO PVC at /app/data, /health liveness + /ready readiness probes. Image URI substituted at deploy.</p></CardContent></Card>
      </div>
    </div>
  );
}

function HealthCard({ variant, path, title, body }: { variant: "success" | "warn" | "default"; path: string; title: string; body: string }) {
  return (
    <Card><CardContent className="p-4">
      <Badge variant={variant === "default" ? "default" : variant}>{path}</Badge>
      <div className="mt-2 text-sm font-semibold">{title}</div>
      <Rich className="mt-1 text-[13px] text-muted-foreground" html={body} />
    </CardContent></Card>
  );
}
