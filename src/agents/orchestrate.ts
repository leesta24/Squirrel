// Main orchestration — a TradingAgents-style pipeline, rewritten on Pi.
// analysts (parallel) → YES/NO debate (N rounds + judgement) → Estimator (p_hat) → Kelly → Risk (may reduce) → Verdict.
// The orchestration is generic: roles/debate teams come from roles.ts config; no role logic is hardcoded here.

import type { UnifiedMarket } from "../data/types.js";
import { yesProbability } from "../data/types.js";
import type { AnalysisState, DebateTeam, RoleConfig, Verdict } from "./types.js";
import type { LLM } from "./llm.js";
import { ANALYSTS, debateTeam, estimator, riskManager } from "./roles.js";
import { estimateTool, riskTool, kelly } from "./verdict.js";

export interface OrchestrateOptions {
  /** Streaming progress callback (for the CLI to print each role's output) */
  onProgress?: (label: string, text: string) => void;
  /** Extra context to inject (e.g. cross-platform arbitrage signals) */
  extras?: string;
}

const pct = (n: number) => (n * 100).toFixed(1) + "%";

function formatContext(market: UnifiedMarket, marketP: number, extras?: string): string {
  const lines = [
    `Market: ${market.question}`,
    `Platform: ${market.source}`,
    `Current market price (implied YES probability): ${pct(marketP)}`,
    market.volume !== undefined ? `Volume: $${Math.round(market.volume).toLocaleString()}` : "",
    market.liquidity !== undefined ? `Liquidity: $${Math.round(market.liquidity).toLocaleString()}` : "",
    market.closeTime ? `Closes: ${market.closeTime}` : "",
    market.description ? `Settlement rules: ${market.description.slice(0, 600)}` : "",
    extras ? `\nCross-platform signal:\n${extras}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

function formatReports(reports: Record<string, string>): string {
  return ANALYSTS.map((r) => reports[r.id] && `[${r.label}]\n${reports[r.id]}`)
    .filter(Boolean)
    .join("\n\n");
}

async function runAnalysts(
  llm: LLM,
  ctx: string,
  onProgress?: OrchestrateOptions["onProgress"],
): Promise<Record<string, string>> {
  const results = await Promise.all(
    ANALYSTS.map(async (role) => {
      const report = await llm.text(role.tier, role.systemPrompt, `${ctx}\n\nProvide your analysis.`);
      onProgress?.(role.label, report);
      return [role.id, report] as const;
    }),
  );
  return Object.fromEntries(results);
}

async function runDebate(
  llm: LLM,
  team: DebateTeam,
  ctx: string,
  reports: Record<string, string>,
  onProgress?: OrchestrateOptions["onProgress"],
): Promise<NonNullable<AnalysisState["debate"]>> {
  const reportText = formatReports(reports);
  let transcript = "";
  for (let round = 0; round < team.rounds; round++) {
    for (const p of team.participants) {
      const prompt =
        `${ctx}\n\nAnalyst reports:\n${reportText}\n\n` +
        `Debate so far:\n${transcript || "(opening statement)"}\n\nYour turn (round ${round + 1}/${team.rounds}).`;
      const say = await llm.text(p.tier, p.systemPrompt, prompt);
      transcript += `\n[${p.label}] ${say}\n`;
      onProgress?.(`${p.label} · round ${round + 1}`, say);
    }
  }
  const judgement = await llm.text(
    team.judge.tier,
    team.judge.systemPrompt,
    `${ctx}\n\nReports:\n${reportText}\n\nDebate:\n${transcript}\n\nDecide the winner.`,
  );
  const winner = /WINNER:\s*YES/i.test(judgement) ? "YES" : /WINNER:\s*NO/i.test(judgement) ? "NO" : "UNCLEAR";
  onProgress?.(team.judge.label, judgement);
  return { transcript, winner, judgement };
}

export async function analyze(
  llm: LLM,
  market: UnifiedMarket,
  opts: OrchestrateOptions = {},
): Promise<AnalysisState> {
  const { onProgress, extras } = opts;
  const marketP = yesProbability(market) ?? 0.5;
  const ctx = formatContext(market, marketP, extras);

  const state: AnalysisState = { market, marketP, context: ctx, reports: {} };

  // 1) Analysts in parallel
  state.reports = await runAnalysts(llm, ctx, onProgress);

  // 2) YES/NO debate + judgement
  state.debate = await runDebate(llm, debateTeam, ctx, state.reports, onProgress);

  // 3) Estimator → p_hat
  const est = await llm.structured<{ pHat: number; reasoning: string }>(
    estimator.tier,
    estimator.systemPrompt,
    `${ctx}\n\nAnalyst reports:\n${formatReports(state.reports)}\n\n` +
      `Debate winner: ${state.debate.winner}\n${state.debate.judgement}\n\nSubmit your calibrated p_hat.`,
    estimateTool,
  );
  state.estimate = { pHat: est.pHat, reasoning: est.reasoning };
  onProgress?.(estimator.label, `p_hat = ${pct(est.pHat)} — ${est.reasoning}`);

  // 4) Kelly sizing (computed in code)
  const k = kelly(est.pHat, marketP);

  // 5) Risk Manager review (may only reduce the size)
  const decision = await llm.structured<{ kellyFraction: number; recommendation: string; reasoning: string }>(
    riskManager.tier,
    riskManager.systemPrompt,
    `${ctx}\n\np_hat=${est.pHat.toFixed(3)}, market=${marketP.toFixed(3)}, ` +
      `edge=${k.edge.toFixed(3)}, side=${k.side}, suggested Kelly=${k.kelly.toFixed(3)}.\n\n` +
      `Resolution-risk report:\n${state.reports[riskManagerInputRole] ?? "(none)"}\n\nDecide the final size.`,
    riskTool,
  );

  // 6) Assemble the verdict: side is driven by Kelly; Risk can only reduce the size
  const finalKelly = k.side === "PASS" ? 0 : Math.min(k.kelly, decision.kellyFraction);
  const verdict: Verdict = {
    side: k.side,
    pHat: est.pHat,
    marketP,
    edge: k.edge,
    kellyFraction: finalKelly,
    recommendation: k.side === "PASS" ? "PASS (edge below threshold)" : decision.recommendation,
    reasoning: decision.reasoning,
  };
  state.verdict = verdict;
  onProgress?.(riskManager.label, `${decision.recommendation} · Kelly ${pct(finalKelly)} — ${decision.reasoning}`);

  return state;
}

const riskManagerInputRole: RoleConfig["id"] = "resolution_risk";
