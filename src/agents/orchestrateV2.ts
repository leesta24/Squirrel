import type { UnifiedMarket } from "../data/types.js";
import { yesProbability } from "../data/types.js";
import type { AnalysisState, RoleConfig, Verdict } from "./types.js";
import { createPredictionMarketTools, pickTools, type ReportSubmission, type VerdictSubmission } from "./tools.js";
import { runPiAgentNode } from "./piNode.js";
import { runGraph, type GraphNode } from "./graphRunner.js";
import { V2_ROLES } from "./rolesV2.js";

export interface OrchestrateV2Options {
  allMarkets?: UnifiedMarket[];
  onProgress?: (label: string, text: string) => void;
}

const pct = (n: number) => (n * 100).toFixed(1) + "%";

function formatContext(market: UnifiedMarket, marketP: number): string {
  return [
    `Target market: ${market.question}`,
    `Platform: ${market.source}`,
    `Market id: ${market.id}`,
    `Current market-implied YES probability: ${pct(marketP)}`,
    market.volume !== undefined ? `Volume: ${Math.round(market.volume)}` : "",
    market.liquidity !== undefined ? `Liquidity: ${Math.round(market.liquidity)}` : "",
    market.closeTime ? `Closes: ${market.closeTime}` : "",
    market.description ? `Settlement rules (may be partial): ${market.description.slice(0, 800)}` : "",
  ].filter(Boolean).join("\n");
}

function formatReports(reports: Record<string, string>): string {
  const entries = Object.entries(reports);
  if (entries.length === 0) return "(none yet)";
  return entries.map(([role, report]) => `[${role}]\n${report}`).join("\n\n");
}

function reportText(report: ReportSubmission): string {
  return [
    report.summary,
    report.keySignals.length ? `Signals: ${report.keySignals.join("; ")}` : "",
    report.risks.length ? `Risks: ${report.risks.join("; ")}` : "",
    report.dataGaps.length ? `Data gaps: ${report.dataGaps.join("; ")}` : "",
    `Confidence: ${report.confidence.toFixed(2)}`,
  ].filter(Boolean).join("\n");
}

function verdictFromSubmission(raw: VerdictSubmission, marketP: number): Verdict {
  const edge = raw.pHat - marketP;
  return {
    side: raw.side,
    pHat: raw.pHat,
    marketP,
    edge,
    kellyFraction: raw.size,
    recommendation: raw.action,
    reasoning: raw.dataGaps.length
      ? `${raw.reasoning} Data gaps: ${raw.dataGaps.join("; ")}`
      : raw.reasoning,
  };
}

function toolNamesFor(role: RoleConfig): string[] {
  switch (role.id) {
    case "market_analyst":
      return ["polymarket_search_markets", "kalshi_search_markets", "get_verified_market_snapshot", "submit_report"];
    case "microstructure_analyst":
      return ["get_probability_indicators", "polymarket_get_orderbook", "kalshi_get_orderbook", "submit_report"];
    case "cross_market_analyst":
      return ["get_cross_platform_anomaly_signals", "get_verified_market_snapshot", "submit_report"];
    case "yes_researcher":
    case "no_researcher":
      return ["get_verified_market_snapshot", "submit_report"];
    case "decision_manager":
      return ["submit_verdict"];
    default:
      return ["submit_report"];
  }
}

export async function analyzeV2(market: UnifiedMarket, opts: OrchestrateV2Options = {}): Promise<AnalysisState> {
  const marketP = yesProbability(market) ?? 0.5;
  const context = formatContext(market, marketP);
  const state: AnalysisState = { market, marketP, context, reports: {} };
  let submittedVerdict: VerdictSubmission | undefined;

  const nodes: GraphNode<AnalysisState>[] = V2_ROLES.map((role) => ({
    id: role.id,
    async run({ state: graphState }) {
      const tools = createPredictionMarketTools({
        market,
        allMarkets: opts.allMarkets,
        roleId: role.id,
        onReport: (roleId, report) => {
          graphState.reports[roleId] = reportText(report);
        },
        onVerdict: (verdict) => {
          submittedVerdict = verdict;
          graphState.verdict = verdictFromSubmission(verdict, marketP);
        },
      });

      const prompt =
        `${graphState.context}\n\nReports so far:\n${formatReports(graphState.reports)}\n\n` +
        "Use your available tools. If you are an analyst/researcher, finish with submit_report. " +
        "If you are the Decision Manager, finish with submit_verdict.";

      const result = await runPiAgentNode({
        role,
        prompt,
        tools: pickTools(tools, toolNamesFor(role)),
        onTool: (label, text) => opts.onProgress?.(`${label} · tool`, text),
      });

      if (role.id !== "decision_manager" && !graphState.reports[role.id]) {
        graphState.reports[role.id] = result.text || "(no report submitted)";
      }
      opts.onProgress?.(role.label, graphState.reports[role.id] ?? result.text);
    },
  }));

  if (!V2_ROLES[0]) throw new Error("v2 graph has no start node");
  await runGraph(
    {
      start: V2_ROLES[0].id,
      nodes,
      edges: Object.fromEntries(
        V2_ROLES.map((role, i) => [role.id, V2_ROLES[i + 1]?.id]),
      ),
      maxSteps: V2_ROLES.length + 2,
    },
    state,
  );

  if (!state.verdict && submittedVerdict) state.verdict = verdictFromSubmission(submittedVerdict, marketP);
  return state;
}
