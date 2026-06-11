import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NewFact } from "../src/memory/types.js";

// Mock pino (same pattern as memoryStore.test.ts)
vi.mock("pino", () => {
  const noop = () => {};
  const logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    fatal: noop,
    trace: noop,
    child: () => logger,
  };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

type Seed = Pick<NewFact, "text" | "category" | "sourceType"> &
  Partial<Pick<NewFact, "assertedAt" | "confidence" | "entities" | "sourceLabel">>;

interface EvalCase {
  name: string;
  seeds: Seed[];
  /** Supersede the seed at `oldIndex` (within this case's seeds) with `fact`. */
  supersede?: { oldIndex: number; fact: Seed };
  query: string;
  /** Empty array = the search must honestly return nothing. */
  expectedTexts: string[];
  /** Texts that must NOT appear in the results at all. */
  mustNotInclude?: string[];
}

// Realistic Newton School distractor corpus seeded into EVERY case so top-k
// rankings face genuine competition.
const DISTRACTORS: Seed[] = [
  { text: "Admissions funnel conversion for the June cohort improved to 14 percent", category: "metric", sourceType: "meeting" },
  { text: "Rahul owns the Metabase dashboard cleanup for finance reporting", category: "owner", sourceType: "conversation" },
  { text: "NST Pune campus hostel wifi upgrade is planned for July 15", category: "deadline", sourceType: "meeting" },
  { text: "Decision: all employer outreach emails must CC the placements alias", category: "decision", sourceType: "email" },
  { text: "Student support NPS for May was 41, up from 36 in April", category: "metric", sourceType: "meeting" },
  { text: "Engineering velocity dropped 20 percent during the migration sprint", category: "fact", sourceType: "meeting" },
  { text: "Decision: counselor follow-up SLA is 24 hours for all new admissions leads", category: "decision", sourceType: "meeting" },
  { text: "Monthly burn rate is 2.1 crore as of May", category: "metric", sourceType: "email" },
  { text: "Priya owns the curriculum revamp for the data science track", category: "owner", sourceType: "meeting" },
  { text: "The mock interview pipeline covers 80 percent of job-ready candidates", category: "fact", sourceType: "conversation" },
];

const CASES: EvalCase[] = [
  {
    name: "synonym: churn query finds attrition fact",
    seeds: [{ text: "Monthly student attrition in the May cohort rose to 8 percent", category: "metric", sourceType: "meeting" }],
    query: "what is the churn rate for the May cohort?",
    expectedTexts: ["Monthly student attrition in the May cohort rose to 8 percent"],
  },
  {
    name: "synonym: attrition query finds churn fact",
    seeds: [{ text: "Paid-user churn for the alumni upskilling product hit 6 percent in Q2", category: "metric", sourceType: "email" }],
    query: "what is the attrition for the alumni upskilling product?",
    expectedTexts: ["Paid-user churn for the alumni upskilling product hit 6 percent in Q2"],
  },
  {
    name: "synonym: salary query finds CTC fact",
    seeds: [{ text: "Average CTC for the 2026 placements batch is 12 LPA", category: "metric", sourceType: "meeting" }],
    query: "what's the average salary for the 2026 placement batch?",
    expectedTexts: ["Average CTC for the 2026 placements batch is 12 LPA"],
  },
  {
    name: "synonym: salary query finds package decision",
    seeds: [{ text: "Decision: minimum package floor for on-campus offers is 4.5 LPA", category: "decision", sourceType: "meeting" }],
    query: "what salary floor did we set for campus offers?",
    expectedTexts: ["Decision: minimum package floor for on-campus offers is 4.5 LPA"],
  },
  {
    name: "Hinglish-flavoured query",
    seeds: [{ text: "Placements team closed 45 offers in May for the 2026 batch", category: "metric", sourceType: "meeting" }],
    query: "placements ka latest update kya hai, kitne offers mile?",
    expectedTexts: ["Placements team closed 45 offers in May for the 2026 batch"],
  },
  {
    name: "short name in query, full name in memory",
    seeds: [{ text: "Siddharth Maheshwari owns the NST internship readiness program", category: "owner", sourceType: "meeting" }],
    query: "who owns internship readiness — Siddharth?",
    expectedTexts: ["Siddharth Maheshwari owns the NST internship readiness program"],
  },
  {
    name: "full name in query, short name in memory",
    seeds: [{ text: "Anish is the DRI for the employer NPS survey revamp", category: "owner", sourceType: "conversation" }],
    query: "what is Anish Singh driving right now?",
    expectedTexts: ["Anish is the DRI for the employer NPS survey revamp"],
  },
  {
    name: "superseded fact must not outrank its replacement",
    seeds: [{ text: "Q3 placement target is 200 offers", category: "decision", sourceType: "meeting", assertedAt: "2026-04-01T00:00:00.000Z" }],
    supersede: {
      oldIndex: 0,
      fact: { text: "Q3 placement target is 250 offers", category: "decision", sourceType: "meeting", assertedAt: "2026-06-01T00:00:00.000Z" },
    },
    query: "what is the Q3 placement target?",
    expectedTexts: ["Q3 placement target is 250 offers"],
    mustNotInclude: ["Q3 placement target is 200 offers"],
  },
  {
    name: "FTS-hostile query (punctuation, slash, dash, apostrophe)",
    seeds: [{ text: "Q3 plan: scale the NST placements pipeline to 300 active employers", category: "decision", sourceType: "meeting" }],
    query: "what's the Q3 plan — placements/NST?",
    expectedTexts: ["Q3 plan: scale the NST placements pipeline to 300 active employers"],
  },
  {
    name: "zero-match honesty: unrelated query returns nothing",
    seeds: [],
    query: "who won the office cricket tournament?",
    expectedTexts: [],
  },
  {
    name: "deadline lookup",
    seeds: [{ text: "NST semester exam results must be published by July 7", category: "deadline", sourceType: "meeting" }],
    query: "when do the NST exam results need to be published?",
    expectedTexts: ["NST semester exam results must be published by July 7"],
  },
  {
    name: "rejection metric lookup (stemmed match)",
    seeds: [{ text: "Placement rejection rate at the screening round is 35 percent", category: "metric", sourceType: "meeting" }],
    query: "how bad are screening rejections for placements?",
    expectedTexts: ["Placement rejection rate at the screening round is 35 percent"],
  },
  {
    name: "decision recall with stemming (sunsetting -> sunset)",
    seeds: [{ text: "Decision: Newton School will sunset the part-time bootcamp by December", category: "decision", sourceType: "meeting" }],
    query: "are we sunsetting the part-time bootcamp?",
    expectedTexts: ["Decision: Newton School will sunset the part-time bootcamp by December"],
  },
  {
    name: "owner lookup with UK spelling (counsellors)",
    seeds: [{ text: "Megha owns admissions counselor hiring for the Bangalore center", category: "owner", sourceType: "conversation" }],
    query: "who is hiring counsellors in Bangalore?",
    expectedTexts: ["Megha owns admissions counselor hiring for the Bangalore center"],
  },
  {
    name: "synonym: cost query finds spend decision",
    seeds: [{ text: "Decision: cap monthly marketing spend at 60 lakh until CAC recovers", category: "decision", sourceType: "meeting" }],
    query: "what's our marketing cost cap?",
    expectedTexts: ["Decision: cap monthly marketing spend at 60 lakh until CAC recovers"],
  },
  {
    name: "synonym: income query finds revenue metric",
    seeds: [{ text: "May revenue closed at 9.4 crore, 6 percent above target", category: "metric", sourceType: "email" }],
    query: "what was our income for May?",
    expectedTexts: ["May revenue closed at 9.4 crore, 6 percent above target"],
  },
  {
    name: "synonym: churn-risk query finds dropout fact",
    seeds: [{ text: "Dropout risk flagged for 23 students in the January cohort", category: "fact", sourceType: "meeting" }],
    query: "how many students are at churn risk in the January cohort?",
    expectedTexts: ["Dropout risk flagged for 23 students in the January cohort"],
  },
  {
    name: "NST operations lookup",
    seeds: [{ text: "NST Sonipat campus needs 12 new faculty before the August semester", category: "fact", sourceType: "meeting" }],
    query: "faculty hiring gap at the Sonipat campus?",
    expectedTexts: ["NST Sonipat campus needs 12 new faculty before the August semester"],
  },
  {
    name: "deadline outranks a related background fact",
    seeds: [
      { text: "Employer summit logistics review is ongoing with the events vendor", category: "fact", sourceType: "conversation" },
      { text: "Employer summit venue must be booked by June 20", category: "deadline", sourceType: "meeting" },
    ],
    query: "employer summit venue booking deadline?",
    expectedTexts: ["Employer summit venue must be booked by June 20"],
  },
  {
    name: "preference recall",
    seeds: [{ text: "Dipesh prefers weekly placement digests on Monday mornings", category: "preference", sourceType: "conversation" }],
    query: "when does Dipesh want the placements digest?",
    expectedTexts: ["Dipesh prefers weekly placement digests on Monday mornings"],
  },
  {
    name: "median offer metric",
    seeds: [{ text: "Median offer for the AI track is 18 LPA this season", category: "metric", sourceType: "meeting" }],
    query: "median ctc for the AI track?",
    expectedTexts: ["Median offer for the AI track is 18 LPA this season"],
  },
  {
    name: "expansion decision (multi-word entity)",
    seeds: [{ text: "Decision: Newton School of Technology will add a Lucknow campus in 2027", category: "decision", sourceType: "meeting" }],
    query: "are we opening a Lucknow campus?",
    expectedTexts: ["Decision: Newton School of Technology will add a Lucknow campus in 2027"],
  },
  {
    name: "email-sourced fact recall",
    seeds: [{ text: "Infosys hiring freeze pauses 40 offers from the February drive", category: "fact", sourceType: "email" }],
    query: "did Infosys freeze our offers?",
    expectedTexts: ["Infosys hiring freeze pauses 40 offers from the February drive"],
  },
  {
    name: "meeting decision recall (decided -> decide stem)",
    seeds: [{ text: "In the growth review we decided to double admissions counselor headcount by Q4", category: "decision", sourceType: "meeting" }],
    query: "what did we decide about counselor headcount?",
    expectedTexts: ["In the growth review we decided to double admissions counselor headcount by Q4"],
  },
];

const K = 5;

interface CaseOutcome {
  name: string;
  hit1: boolean;
  hit5: boolean;
}

const outcomes: CaseOutcome[] = [];

describe("memory retrieval golden-set eval", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../src/config.js", () => ({
      config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent" },
    }));
  });

  afterEach(async () => {
    const { closeDb } = await import("../src/state/db.js");
    closeDb();
  });

  for (const c of CASES) {
    it(c.name, async () => {
      const { getDb } = await import("../src/state/db.js");
      const sql = await import("../src/memory/memorySql.js");
      const { searchMemories } = await import("../src/memory/memoryStore.js");
      const db = getDb();

      for (const seed of DISTRACTORS) {
        sql.insertFact(db, seed);
      }
      const seedIds: number[] = [];
      for (const seed of c.seeds) {
        seedIds.push(sql.insertFact(db, seed).id);
      }
      if (c.supersede) {
        sql.supersedeMemory(db, seedIds[c.supersede.oldIndex], c.supersede.fact);
      }

      const results = searchMemories(c.query, K);
      const texts = results.map((r) => r.text);

      if (c.expectedTexts.length === 0) {
        expect(results).toEqual([]);
        return;
      }

      for (const banned of c.mustNotInclude ?? []) {
        expect(texts).not.toContain(banned);
      }

      outcomes.push({
        name: c.name,
        hit1: texts.length > 0 && c.expectedTexts.includes(texts[0]),
        hit5: c.expectedTexts.some((t) => texts.includes(t)),
      });
    });
  }

  it("aggregate: hit@5 >= 0.9 and hit@1 >= 0.6 across the golden set", () => {
    const scored = CASES.filter((c) => c.expectedTexts.length > 0).length;
    expect(outcomes).toHaveLength(scored);

    const hit5 = outcomes.filter((o) => o.hit5).length / outcomes.length;
    const hit1 = outcomes.filter((o) => o.hit1).length / outcomes.length;

    const misses5 = outcomes.filter((o) => !o.hit5).map((o) => o.name);
    const misses1 = outcomes.filter((o) => !o.hit1).map((o) => o.name);

    // Surface the actual rates + misses in the assertion message for tuning.
    expect(hit5, `hit@5=${hit5.toFixed(3)} misses: ${misses5.join("; ")}`).toBeGreaterThanOrEqual(0.9);
    expect(hit1, `hit@1=${hit1.toFixed(3)} misses: ${misses1.join("; ")}`).toBeGreaterThanOrEqual(0.6);
  });
});
