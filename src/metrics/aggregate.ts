/**
 * Pure classification + aggregation for Sentinel memory monitoring.
 * No I/O — tests feed it mock process lists.
 */

export interface RawProcess {
  pid: number;
  rssKb: number;
  cpu: number;
  command: string;
}

export type ProcessType =
  | "sentinel-main"
  | "meet-joiner"
  | "chrome-main"
  | "chrome-renderer"
  | "chrome-gpu"
  | "chrome-helper";

export interface ClassifiedProcess extends RawProcess {
  type: ProcessType;
  rssMb: number;
}

export interface MemorySummary {
  timestamp: string;
  totalRssMb: number;
  totalCpuPct: number;
  activeMeetings: number;
  counts: Record<ProcessType, number>;
  processes: Array<{
    pid: number;
    type: ProcessType;
    rssMb: number;
    cpu: number;
    command: string;
  }>;
}

const PROFILE_PATH_MARKER = "sentinel-chrome-profile";

export function classifyProcess(p: RawProcess): ProcessType | null {
  const cmd = p.command;

  // Meet bot joiner subprocess
  if (/src\/meet-bot\/joiner\.ts|dist\/meet-bot\/joiner\.js/.test(cmd)) {
    return "meet-joiner";
  }

  // Sentinel main process (tsx direct, tsx preflight wrapper, or compiled)
  const isSentinelEntry =
    /tsx.*src\/index\.ts/.test(cmd) ||
    /tsx\/dist\/preflight\.cjs/.test(cmd) ||
    /dist\/index\.js/.test(cmd);
  if (isSentinelEntry && !/src\/meet-bot\/joiner/.test(cmd)) {
    return "sentinel-main";
  }

  // Chrome processes — only those tied to our dedicated profile
  if (!cmd.includes(PROFILE_PATH_MARKER)) return null;

  if (/Helper \(Renderer\)/.test(cmd)) return "chrome-renderer";
  if (/Helper \(GPU\)/.test(cmd)) return "chrome-gpu";
  if (/Google Chrome Helper/.test(cmd)) return "chrome-helper";
  // The primary Chrome binary (no "Helper" in the path)
  if (/Google Chrome\.app\/Contents\/MacOS\/Google Chrome/.test(cmd) || /Google Chrome /.test(cmd)) {
    return "chrome-main";
  }

  return null;
}

export function aggregateProcesses(
  procs: RawProcess[],
  timestamp: string
): MemorySummary {
  const classified: ClassifiedProcess[] = [];
  for (const p of procs) {
    const type = classifyProcess(p);
    if (!type) continue;
    classified.push({ ...p, type, rssMb: p.rssKb / 1024 });
  }

  const counts: Record<ProcessType, number> = {
    "sentinel-main": 0,
    "meet-joiner": 0,
    "chrome-main": 0,
    "chrome-renderer": 0,
    "chrome-gpu": 0,
    "chrome-helper": 0,
  };
  let totalRssMb = 0;
  let totalCpuPct = 0;
  for (const p of classified) {
    counts[p.type]++;
    totalRssMb += p.rssMb;
    totalCpuPct += p.cpu;
  }

  return {
    timestamp,
    totalRssMb: round(totalRssMb, 1),
    totalCpuPct: round(totalCpuPct, 1),
    activeMeetings: counts["meet-joiner"],
    counts,
    processes: classified.map((p) => ({
      pid: p.pid,
      type: p.type,
      rssMb: round(p.rssMb, 1),
      cpu: p.cpu,
      command: p.command.slice(0, 200),
    })),
  };
}

function round(n: number, decimals: number): number {
  const m = Math.pow(10, decimals);
  return Math.round(n * m) / m;
}
