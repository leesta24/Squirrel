// Out-of-sample backtest — the real test of forward-looking skill.
// Uses Polymarket markets that SETTLED after the model's knowledge cutoff (2026-01),
// fed with the PRE-settlement market price (from prices-history), never the resolution price.
// The model only has cutoff-era background + the market price; it cannot "remember" the outcome.

import { fetchJson } from "./data/http.js";
import { analyze } from "./agents/orchestrate.js";
import type { LLM } from "./agents/llm.js";
import type { UnifiedMarket } from "./data/types.js";

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

const DAYS_BEFORE = 14;
// Settled on/after this date → settlement (and the -14d snapshot) fall after the 2026-01 cutoff,
// so the model can't have seen the outcome.
const SETTLE_AFTER = "2026-02-15";
// Only keep markets that still had genuine uncertainty 14d out — a fair calibration test,
// not "predict a sudden breaking-news jump".
const MIN_PROB = 0.15;
const MAX_PROB = 0.85;
const MAX_CASES = 10;

interface RawMarket {
  conditionId?: string;
  question?: string;
  description?: string;
  outcomes?: string;
  outcomePrices?: string;
  clobTokenIds?: string;
  volumeNum?: number;
  updatedAt?: string;
}

interface HistPoint {
  t: number;
  p: number;
}

export interface OOSCase {
  question: string;
  description?: string;
  /** market-implied YES prob `DAYS_BEFORE` days before settlement */
  marketPBefore: number;
  /** actual outcome (1 = YES happened) */
  actual: 0 | 1;
  settleDate: string;
  beforeDate: string;
}

const parseArr = (s?: string): string[] => {
  try {
    const v = JSON.parse(s ?? "[]");
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};
const fmtDate = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

/**
 * Auto-select settled binary markets that (a) settled after the model cutoff and (b) still had
 * genuine uncertainty 14 days before settlement. Reconstruct pre-settlement price + actual outcome.
 */
export async function fetchOOSCases(): Promise<OOSCase[]> {
  const raw = await fetchJson<RawMarket[]>(
    `${GAMMA}/markets?closed=true&limit=600&order=volumeNum&ascending=false`,
  );
  const cases: OOSCase[] = [];

  for (const m of raw) {
    if (cases.length >= MAX_CASES) break;
    if (!m.conditionId) continue;
    if ((m.updatedAt ?? "").slice(0, 10) < SETTLE_AFTER) continue; // settled after cutoff

    const outs = parseArr(m.outcomes);
    const prices = parseArr(m.outcomePrices);
    const tokens = parseArr(m.clobTokenIds);
    const yesToken = tokens[0];
    if (outs.length !== 2 || outs[0] !== "Yes" || !yesToken) continue; // binary Yes/No only
    const p0 = parseFloat(prices[0] ?? "-1");
    if (p0 !== 0 && p0 !== 1) continue; // cleanly resolved only
    const actual: 0 | 1 = p0 >= 0.5 ? 1 : 0;

    let points: HistPoint[];
    try {
      const hist = await fetchJson<{ history: HistPoint[] }>(
        `${CLOB}/prices-history?market=${yesToken}&interval=max&fidelity=720`,
      );
      points = hist.history ?? [];
    } catch {
      continue;
    }
    if (points.length === 0) continue;
    const settleTs = points[points.length - 1]!.t;
    const beforeTs = settleTs - DAYS_BEFORE * 86400;
    const before = [...points].reverse().find((pt) => pt.t <= beforeTs);
    if (!before) continue;
    const p14 = Math.min(1, Math.max(0, before.p));
    if (p14 < MIN_PROB || p14 > MAX_PROB) continue; // genuine uncertainty only

    const c: OOSCase = {
      question: m.question ?? "",
      marketPBefore: p14,
      actual,
      settleDate: fmtDate(settleTs),
      beforeDate: fmtDate(before.t),
    };
    if (m.description) c.description = m.description;
    cases.push(c);
  }
  return cases;
}

export interface OOSResult {
  question: string;
  actual: number;
  pHat: number;
  marketPBefore: number;
  directionCorrect: boolean;
}

export interface OOSSummary {
  rows: OOSResult[];
  accuracy: number;
  brierModel: number;
  brierMarket: number;
  brierNaive: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export async function runOOS(
  llm: LLM,
  cases: OOSCase[],
  onCase?: (c: OOSCase, pHat: number) => void,
): Promise<OOSSummary> {
  const rows: OOSResult[] = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    const market: UnifiedMarket = {
      source: "polymarket",
      id: `oos-${i}`,
      question: c.question,
      outcomes: [
        { name: "Yes", probability: c.marketPBefore },
        { name: "No", probability: 1 - c.marketPBefore },
      ],
    };
    if (c.description) market.description = c.description;
    const state = await analyze(llm, market);
    const pHat = state.verdict?.pHat ?? state.estimate?.pHat ?? 0.5;
    rows.push({
      question: c.question,
      actual: c.actual,
      pHat,
      marketPBefore: c.marketPBefore,
      directionCorrect: (pHat >= 0.5 ? 1 : 0) === c.actual,
    });
    onCase?.(c, pHat);
  }
  return {
    rows,
    accuracy: rows.filter((r) => r.directionCorrect).length / (rows.length || 1),
    brierModel: mean(rows.map((r) => (r.pHat - r.actual) ** 2)),
    brierMarket: mean(rows.map((r) => (r.marketPBefore - r.actual) ** 2)),
    brierNaive: mean(rows.map((r) => (0.5 - r.actual) ** 2)),
  };
}
