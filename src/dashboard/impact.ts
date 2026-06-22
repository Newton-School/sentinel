/**
 * Executive-impact aggregation for the dashboard's leadership view: month-over-
 * month KPIs, an 8-week usage+satisfaction trend, and coverage breakdowns
 * (business area, data sources, top users). Self-contained SQL over a Queryable.
 */

import type { Queryable } from "../state/db.js";

export interface ImpactKpis {
  queries: number;
  users: number;
  positive: number;
  negative: number;
  costUsd: number;
}
export interface WeeklyPoint { weekStart: string; queries: number; positiveRatio: number | null; }
export interface Count { key: string; count: number; }
export interface TopUser { userId: string; displayName: string | null; role: string | null; count: number; }

export interface Impact {
  current: ImpactKpis;
  previous: ImpactKpis;
  windowStart: string;
  weekly: WeeklyPoint[];
  categories: Count[];
  sources: Count[];
  topUsers: TopUser[];
}

function monthStartIso(d: Date, deltaMonths = 0): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + deltaMonths, 1)).toISOString();
}

export async function getImpact(db: Queryable, opts: { now?: string } = {}): Promise<Impact> {
  const now = opts.now ? new Date(opts.now) : new Date();
  const thisMonth = monthStartIso(now, 0);
  const lastMonth = monthStartIso(now, -1);
  const windowStart = new Date(now.getTime() - 56 * 86_400_000).toISOString();

  const kpi = async (from: string, to: string | null): Promise<ImpactKpis> => {
    const [ql, fb, cost] = await Promise.all([
      db.query(
        `SELECT count(*)::int q, count(distinct user_id)::int u FROM query_log
         WHERE created_at >= $1 AND ($2::text IS NULL OR created_at < $2)`,
        [from, to]
      ),
      db.query(
        `SELECT count(*) FILTER (WHERE sentiment='positive')::int p,
                count(*) FILTER (WHERE sentiment='negative')::int n
         FROM feedback WHERE created_at >= $1 AND ($2::text IS NULL OR created_at < $2)`,
        [from, to]
      ),
      db.query(
        `SELECT COALESCE(sum(cost_usd),0)::float8 c FROM llm_calls
         WHERE created_at >= $1 AND ($2::text IS NULL OR created_at < $2)`,
        [from, to]
      ),
    ]);
    return {
      queries: (ql.rows[0] as any).q,
      users: (ql.rows[0] as any).u,
      positive: (fb.rows[0] as any).p,
      negative: (fb.rows[0] as any).n,
      costUsd: (cost.rows[0] as any).c,
    };
  };

  const [current, previous] = await Promise.all([kpi(thisMonth, null), kpi(lastMonth, thisMonth)]);

  const [wkQ, wkF, cats, srcRows, tops] = await Promise.all([
    db.query(
      `SELECT to_char(date_trunc('week', created_at::timestamptz),'YYYY-MM-DD') wk, count(*)::int q
       FROM query_log WHERE created_at >= $1 GROUP BY wk ORDER BY wk`,
      [windowStart]
    ),
    db.query(
      `SELECT to_char(date_trunc('week', created_at::timestamptz),'YYYY-MM-DD') wk,
              count(*) FILTER (WHERE sentiment='positive')::int p, count(*)::int t
       FROM feedback WHERE created_at >= $1 GROUP BY wk`,
      [windowStart]
    ),
    db.query(
      `SELECT category key, count(*)::int count FROM query_log
       WHERE created_at >= $1 AND category IS NOT NULL GROUP BY category ORDER BY count DESC`,
      [windowStart]
    ),
    // Pull raw sources_used and aggregate in JS — robust to any non-JSON value.
    db.query(
      `SELECT sources_used FROM query_log
       WHERE created_at >= $1 AND sources_used IS NOT NULL LIMIT 5000`,
      [windowStart]
    ),
    db.query(
      `SELECT q.user_id, count(*)::int count, p.display_name, p.role
       FROM query_log q LEFT JOIN personas p ON p.user_id = q.user_id
       WHERE q.created_at >= $1 GROUP BY q.user_id, p.display_name, p.role ORDER BY count DESC LIMIT 10`,
      [windowStart]
    ),
  ]);

  const fbByWeek = new Map(
    wkF.rows.map((r: Record<string, unknown>) => [r.wk as string, { p: r.p as number, t: r.t as number }])
  );
  const weekly: WeeklyPoint[] = wkQ.rows.map((r: Record<string, unknown>) => {
    const f = fbByWeek.get(r.wk as string);
    const t = f?.t ?? 0;
    return { weekStart: r.wk as string, queries: r.q as number, positiveRatio: t > 0 ? f!.p / t : null };
  });

  const srcCounts = new Map<string, number>();
  for (const row of srcRows.rows as Array<{ sources_used: string }>) {
    try {
      const arr = JSON.parse(row.sources_used);
      if (Array.isArray(arr)) for (const s of arr) srcCounts.set(String(s), (srcCounts.get(String(s)) ?? 0) + 1);
    } catch {
      /* ignore malformed */
    }
  }
  const sources: Count[] = [...srcCounts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);

  return {
    current,
    previous,
    windowStart,
    weekly,
    categories: cats.rows.map((r: Record<string, unknown>) => ({ key: r.key as string, count: r.count as number })),
    sources,
    topUsers: tops.rows.map((r: Record<string, unknown>) => ({
      userId: r.user_id as string,
      count: r.count as number,
      displayName: (r.display_name as string | null) ?? null,
      role: (r.role as string | null) ?? null,
    })),
  };
}
