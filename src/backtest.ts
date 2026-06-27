// Backtest — an objective validation of the agent decision layer (PLAN §11 acceptance point 3).
// Take settled events, feed only the "pre-settlement" market price, let the agent estimate p_hat,
// then compare against the actual 0/1 outcome.
// Use the Brier score to quantify calibration error, and compare it against the "market price itself" baseline.
//
// The prototype uses curated fixtures (pre-settlement market price is an approximate snapshot); extension point:
// wiring up the Polymarket prices-history API enables fully automated historical backtesting (see README).

import type { UnifiedMarket } from "./data/types.js";
import type { LLM } from "./agents/llm.js";
import { analyze } from "./agents/orchestrate.js";

export interface BacktestCase {
  question: string;
  description?: string;
  /** Market-implied YES probability at some point before settlement */
  marketPBefore: number;
  /** Actual outcome */
  actual: 0 | 1;
}

// Settled-event fixtures (illustrative). All outcomes are publicly known; marketPBefore is the approximate pre-settlement market price.
export const FIXTURES: BacktestCase[] = [
  { question: "Will Donald Trump win the 2024 US Presidential Election?", marketPBefore: 0.58, actual: 1 },
  { question: "Will Kamala Harris win the 2024 US Presidential Election?", marketPBefore: 0.42, actual: 0 },
  { question: "Will the Fed cut interest rates in September 2024?", marketPBefore: 0.72, actual: 1 },
  { question: "Will Bitcoin reach $100,000 by the end of 2024?", marketPBefore: 0.45, actual: 1 },
  { question: "Will GTA VI be released in 2025?", marketPBefore: 0.28, actual: 0 },
];

export interface BacktestRow {
  question: string;
  actual: number;
  pHat: number;
  marketP: number;
  directionCorrect: boolean;
}

export interface BacktestSummary {
  rows: BacktestRow[];
  accuracy: number;
  brierModel: number;
  brierMarket: number;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function caseToMarket(c: BacktestCase, i: number): UnifiedMarket {
  const m: UnifiedMarket = {
    source: "polymarket",
    id: `backtest-${i}`,
    question: c.question,
    outcomes: [
      { name: "Yes", probability: c.marketPBefore },
      { name: "No", probability: 1 - c.marketPBefore },
    ],
  };
  if (c.description) m.description = c.description;
  return m;
}

export async function backtest(
  llm: LLM,
  cases: BacktestCase[] = FIXTURES,
  onCase?: (c: BacktestCase, pHat: number) => void,
): Promise<BacktestSummary> {
  const rows: BacktestRow[] = [];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    const state = await analyze(llm, caseToMarket(c, i));
    const pHat = state.verdict?.pHat ?? state.estimate?.pHat ?? 0.5;
    rows.push({
      question: c.question,
      actual: c.actual,
      pHat,
      marketP: c.marketPBefore,
      directionCorrect: (pHat >= 0.5 ? 1 : 0) === c.actual,
    });
    onCase?.(c, pHat);
  }
  return {
    rows,
    accuracy: rows.filter((r) => r.directionCorrect).length / (rows.length || 1),
    brierModel: mean(rows.map((r) => (r.pHat - r.actual) ** 2)),
    brierMarket: mean(rows.map((r) => (r.marketP - r.actual) ** 2)),
  };
}
