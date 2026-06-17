/**
 * Validates the committed Grafana dashboard and (only with --apply + creds)
 * pushes it to Grafana. The repo JSON is the source of truth; this script keeps
 * the live dashboard from drifting from it.
 *
 *   npm run grafana:validate    # parse + validate + list referenced metrics
 *   npm run grafana:provision   # same, then POST to Grafana (needs creds)
 *
 * Applying requires GRAFANA_URL + GRAFANA_TOKEN; without --apply it is a
 * dry-run and never touches Grafana.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface DashboardModel {
  title?: string;
  panels?: Array<{ title?: string; targets?: Array<{ expr?: string }> }>;
}

export const DASHBOARD_PATH = "grafana/sentinel-llmops-dashboard.json";

/** Returns a list of structural problems (empty = valid). */
export function validateDashboard(d: DashboardModel): string[] {
  const errors: string[] = [];
  if (!d.title) errors.push("missing title");
  if (!Array.isArray(d.panels) || d.panels.length === 0) errors.push("no panels");
  for (const [i, p] of (d.panels ?? []).entries()) {
    if (!p.title) errors.push(`panel ${i} missing title`);
    if (!Array.isArray(p.targets) || p.targets.length === 0) {
      errors.push(`panel "${p.title ?? i}" has no targets`);
    }
    for (const t of p.targets ?? []) {
      if (!t.expr) errors.push(`panel "${p.title ?? i}" has a target with no expr`);
    }
  }
  return errors;
}

/** Base metric names referenced by the dashboard (histogram suffixes stripped). */
export function extractMetricNames(d: DashboardModel): string[] {
  const names = new Set<string>();
  for (const p of d.panels ?? []) {
    for (const t of p.targets ?? []) {
      for (const m of (t.expr ?? "").match(/sentinel_[a-z0-9_]+/g) ?? []) {
        names.add(m.replace(/_(bucket|sum|count)$/, ""));
      }
    }
  }
  return [...names].sort();
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const dashboard = JSON.parse(readFileSync(DASHBOARD_PATH, "utf8")) as DashboardModel;

  const errors = validateDashboard(dashboard);
  if (errors.length > 0) {
    console.error("[grafana] invalid dashboard:\n  " + errors.join("\n  "));
    process.exitCode = 1;
    return;
  }
  console.log(`[grafana] dashboard "${dashboard.title}" valid (${dashboard.panels!.length} panels)`);
  console.log(`[grafana] metrics referenced: ${extractMetricNames(dashboard).join(", ")}`);

  if (!apply) {
    console.log("[grafana] dry-run — pass --apply (with GRAFANA_URL + GRAFANA_TOKEN) to push.");
    return;
  }

  const url = process.env.GRAFANA_URL;
  const token = process.env.GRAFANA_TOKEN;
  if (!url || !token) {
    console.error("[grafana] --apply requires GRAFANA_URL and GRAFANA_TOKEN env vars.");
    process.exitCode = 1;
    return;
  }
  const res = await fetch(`${url.replace(/\/$/, "")}/api/dashboards/db`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ dashboard, overwrite: true }),
  });
  if (!res.ok) {
    console.error(`[grafana] push failed: HTTP ${res.status}`);
    process.exitCode = 1;
    return;
  }
  console.log("[grafana] dashboard pushed.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
