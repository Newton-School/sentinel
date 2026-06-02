#!/usr/bin/env node

/**
 * Memory monitor for Sentinel and its spawned processes (Chrome, MCP servers,
 * meet-bot joiners). Runs forever, writing one JSON-lines record every 5 min
 * to data/metrics/memory-YYYY-MM-DD.jsonl.
 *
 * Usage:
 *   npx tsx scripts/monitor-memory.ts                  # every 5 min
 *   npx tsx scripts/monitor-memory.ts --interval 60    # every 60s (testing)
 *   npx tsx scripts/monitor-memory.ts --once           # single snapshot
 *
 * The file is JSON-lines (one record per line). To inspect:
 *   tail -f data/metrics/memory-*.jsonl | jq .
 */

import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  aggregateProcesses,
  type RawProcess,
} from "../src/metrics/aggregate.js";

const DEFAULT_INTERVAL_SEC = 5 * 60;
const METRICS_DIR = join(process.cwd(), "data", "metrics");

function parseArgs(argv: string[]): { intervalSec: number; once: boolean } {
  let intervalSec = DEFAULT_INTERVAL_SEC;
  const idx = argv.indexOf("--interval");
  if (idx !== -1 && argv[idx + 1]) {
    intervalSec = parseInt(argv[idx + 1], 10);
  }
  const once = argv.includes("--once");
  return { intervalSec, once };
}

function snapshotProcesses(): RawProcess[] {
  // ps output: pid, rss (kb), %cpu, command
  // Use comm= last with no width limit so we get the full command line.
  const raw = execSync("ps -eo pid=,rss=,%cpu=,command= 2>/dev/null", {
    encoding: "utf-8",
  });

  const procs: RawProcess[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/);
    if (!match) continue;
    procs.push({
      pid: parseInt(match[1], 10),
      rssKb: parseInt(match[2], 10),
      cpu: parseFloat(match[3]),
      command: match[4],
    });
  }
  return procs;
}

function logFilePath(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return join(METRICS_DIR, `memory-${y}-${m}-${d}.jsonl`);
}

function takeSample(peakRssMb: { value: number }): void {
  const procs = snapshotProcesses();
  const now = new Date();
  const summary = aggregateProcesses(procs, now.toISOString());

  if (summary.totalRssMb > peakRssMb.value) peakRssMb.value = summary.totalRssMb;
  const enriched = { ...summary, peakRssMbSession: peakRssMb.value };

  mkdirSync(METRICS_DIR, { recursive: true });
  const path = logFilePath(now);
  appendFileSync(path, JSON.stringify(enriched) + "\n");

  // Human-readable stderr line so you can tail the process output too
  console.error(
    `[${now.toISOString()}] total=${summary.totalRssMb} MB  cpu=${summary.totalCpuPct}%  meetings=${summary.activeMeetings}  counts=${JSON.stringify(summary.counts)}  → ${path}`
  );
}

async function main(): Promise<void> {
  const { intervalSec, once } = parseArgs(process.argv.slice(2));
  const peakRssMb = { value: 0 };

  console.error(`Memory monitor starting. Interval: ${intervalSec}s, once: ${once}`);
  console.error(`Output: ${METRICS_DIR}/memory-YYYY-MM-DD.jsonl`);

  takeSample(peakRssMb);
  if (once) return;

  setInterval(() => {
    try {
      takeSample(peakRssMb);
    } catch (err) {
      console.error("Monitor sample failed:", err);
    }
  }, intervalSec * 1000);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
