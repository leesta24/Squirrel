import type { UnifiedMarket } from "../data/types.js";
import { yesProbability } from "../data/types.js";
import type { AnalysisState, RoleConfig, Verdict } from "./types.js";
import {
  createPredictionMarketTools,
  pickTools,
  type JudgementSubmission,
  type ReportSubmission,
  type VerdictSubmission,
} from "./tools.js";
import { runPiAgentNode } from "./piNode.js";
import { runGraph, type GraphEdge, type GraphNode } from "./graphRunner.js";
import {
  debateJudgeV2,
  decisionManagerV2,
  noResearcherV2,
  V2_ANALYSTS,
  V2_DEBATE_PARTICIPANTS,
  V2_MAX_DEBATE_ROUNDS,
  V2_MIN_DEBATE_ROUNDS,
} from "./rolesV2.js";

export interface OrchestrateV2Options {
  allMarkets?: UnifiedMarket[];
  onProgress?: (label: string, text: string) => void;
}

interface V2GraphState extends AnalysisState {
  debateRound: number;
  minDebateRounds: number;
  maxDebateRounds: number;
  debateLog: string[];
  reportSubmissions: Record<string, ReportSubmission>;
  routeDecisions: RouteDecision[];
  lastRoute?: RouteDecision;
}

type RouteTarget = "yes_researcher" | "debate_judge";

interface RouteDecision {
  round: number;
  next: RouteTarget;
  reason: string;
  signals: string[];
}

const pct = (n: number) => (n * 100).toFixed(1) + "%";
const OUTPUT_TOOL_INSTRUCTION =
  "When you finish, call exactly one output tool with normal JSON arguments. Do not put XML tags or nested parameter markup inside string fields.";

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

function formatAnalystReports(state: AnalysisState): string {
  const reports = V2_ANALYSTS.map((role) => state.reports[role.id] && `[${role.label}]\n${state.reports[role.id]}`)
    .filter(Boolean);
  return reports.length ? reports.join("\n\n") : "(none yet)";
}

function formatDebateTranscript(state: V2GraphState): string {
  return state.debateLog.length ? state.debateLog.join("\n\n") : "(debate not started)";
}

function reportText(report: ReportSubmission): string {
  const keySignals = report.keySignals ?? [];
  const risks = report.risks ?? [];
  const dataGaps = report.dataGaps ?? [];
  return [
    report.summary,
    keySignals.length ? `Signals: ${keySignals.join("; ")}` : "",
    risks.length ? `Risks: ${risks.join("; ")}` : "",
    dataGaps.length ? `Data gaps: ${dataGaps.join("; ")}` : "",
    `Confidence: ${report.confidence.toFixed(2)}`,
  ].filter(Boolean).join("\n");
}

function judgementText(judgement: JudgementSubmission): string {
  return [
    `WINNER: ${judgement.winner}`,
    judgement.reasoning,
    judgement.strongestYesClaims.length ? `Strongest YES claims: ${judgement.strongestYesClaims.join("; ")}` : "",
    judgement.strongestNoClaims.length ? `Strongest NO claims: ${judgement.strongestNoClaims.join("; ")}` : "",
    judgement.dataGaps.length ? `Data gaps: ${judgement.dataGaps.join("; ")}` : "",
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

function winnerFromText(text: string): NonNullable<AnalysisState["debate"]>["winner"] {
  if (/WINNER:\s*YES/i.test(text)) return "YES";
  if (/WINNER:\s*NO/i.test(text)) return "NO";
  return "UNCLEAR";
}

function latestDebateReports(state: V2GraphState): ReportSubmission[] {
  const round = state.debateRound;
  return [
    state.reportSubmissions[`yes_researcher_round_${round}`],
    state.reportSubmissions[`no_researcher_round_${round}`],
  ].filter((report): report is ReportSubmission => Boolean(report));
}

function unique(xs: string[]): string[] {
  return [...new Set(xs.filter(Boolean))];
}

function criticalGapSignals(reports: ReportSubmission[]): string[] {
  const gapText = reports.flatMap((report) => report.dataGaps).join(" | ").toLowerCase();
  const checks: [string, RegExp][] = [
    ["current_price_missing", /current.*(price|spot)|spot.*price/],
    ["settlement_source_unclear", /settlement|reference source|resolution/],
    ["volatility_distribution_missing", /volatility|distribution|skew/],
    ["cross_platform_validation_missing", /cross-platform|comparable|kalshi|polymarket/],
  ];
  return checks.filter(([, pattern]) => pattern.test(gapText)).map(([signal]) => signal);
}

function averageConfidence(reports: ReportSubmission[]): number | undefined {
  if (reports.length === 0) return undefined;
  return reports.reduce((sum, report) => sum + report.confidence, 0) / reports.length;
}

function routeAfterDebate(state: V2GraphState): RouteDecision {
  const reports = latestDebateReports(state);
  const avgConfidence = averageConfidence(reports);
  const criticalGaps = criticalGapSignals(reports);
  const signals = unique([
    avgConfidence !== undefined ? `avg_confidence=${avgConfidence.toFixed(2)}` : "avg_confidence=missing",
    ...criticalGaps,
  ]);

  if (state.debateRound < state.minDebateRounds) {
    return {
      round: state.debateRound,
      next: "yes_researcher",
      reason: `minimum debate rounds not reached (${state.debateRound}/${state.minDebateRounds})`,
      signals,
    };
  }

  if (state.debateRound >= state.maxDebateRounds) {
    return {
      round: state.debateRound,
      next: "debate_judge",
      reason: `maximum debate rounds reached (${state.debateRound}/${state.maxDebateRounds})`,
      signals,
    };
  }

  if (avgConfidence !== undefined && avgConfidence < 0.62) {
    return {
      round: state.debateRound,
      next: "yes_researcher",
      reason: `latest debate confidence is low (${avgConfidence.toFixed(2)} < 0.62)`,
      signals,
    };
  }

  if (criticalGaps.length > 0) {
    return {
      round: state.debateRound,
      next: "yes_researcher",
      reason: `critical data gaps remain: ${criticalGaps.join(", ")}`,
      signals,
    };
  }

  return {
    round: state.debateRound,
    next: "debate_judge",
    reason: "latest debate reports are confident enough and no critical gaps were flagged",
    signals,
  };
}

function formatRouteHistory(state: V2GraphState): string {
  if (state.routeDecisions.length === 0) return "(none yet)";
  return state.routeDecisions
    .map((decision) =>
      `Round ${decision.round}: next=${decision.next}; reason=${decision.reason}; signals=${decision.signals.join(", ") || "none"}`,
    )
    .join("\n");
}

function toolNamesFor(role: RoleConfig): string[] {
  switch (role.id) {
    case "market_analyst":
      return ["get_verified_market_snapshot", "get_probability_indicators", "submit_report"];
    case "microstructure_analyst":
      return ["get_probability_indicators", "get_verified_market_snapshot", "submit_report"];
    case "cross_market_analyst":
      return ["get_cross_platform_anomaly_signals", "get_verified_market_snapshot", "submit_report"];
    case "yes_researcher":
    case "no_researcher":
      return ["get_verified_market_snapshot", "get_probability_indicators", "submit_report"];
    case "debate_judge":
      return ["submit_judgement"];
    case "decision_manager":
      return ["get_verified_market_snapshot", "get_probability_indicators", "submit_verdict"];
    default:
      return ["submit_report"];
  }
}

function makeTools(opts: {
  state: V2GraphState;
  market: UnifiedMarket;
  allMarkets?: UnifiedMarket[];
  reportKey: string;
  marketP: number;
}) {
  return createPredictionMarketTools({
    market: opts.market,
    allMarkets: opts.allMarkets,
    roleId: opts.reportKey,
    onReport: (roleId, report) => {
      opts.state.reports[roleId] = reportText(report);
      opts.state.reportSubmissions[roleId] = report;
    },
    onJudgement: (judgement) => {
      opts.state.debate = {
        transcript: formatDebateTranscript(opts.state),
        winner: judgement.winner,
        judgement: judgementText(judgement),
      };
    },
    onVerdict: (verdict) => {
      opts.state.verdict = verdictFromSubmission(verdict, opts.marketP);
    },
  });
}

async function runReportNode(opts: {
  state: V2GraphState;
  role: RoleConfig;
  reportKey: string;
  progressLabel: string;
  prompt: string;
  market: UnifiedMarket;
  allMarkets?: UnifiedMarket[];
  marketP: number;
  onProgress?: OrchestrateV2Options["onProgress"];
}): Promise<string> {
  const tools = makeTools({
    state: opts.state,
    market: opts.market,
    allMarkets: opts.allMarkets,
    reportKey: opts.reportKey,
    marketP: opts.marketP,
  });

  const result = await runPiAgentNode({
    role: { ...opts.role, label: opts.progressLabel },
    prompt: opts.prompt,
    tools: pickTools(tools, toolNamesFor(opts.role)),
    onTool: (label, text) => opts.onProgress?.(`${label} · tool`, text),
  });

  const report = opts.state.reports[opts.reportKey] ?? (result.text || "(no report submitted)");
  opts.state.reports[opts.reportKey] = report;
  opts.onProgress?.(opts.progressLabel, report);
  return report;
}

function analystPrompt(state: V2GraphState): string {
  return [
    state.context,
    `Reports so far:\n${formatAnalystReports(state)}`,
    "Use your available tools to verify facts. Finish by calling submit_report.",
    OUTPUT_TOOL_INSTRUCTION,
  ].join("\n\n");
}

function debatePrompt(state: V2GraphState, role: RoleConfig, round: number): string {
  return [
    state.context,
    `Analyst reports:\n${formatAnalystReports(state)}`,
    `Debate transcript so far:\n${formatDebateTranscript(state)}`,
    `Router notes so far:\n${formatRouteHistory(state)}`,
    `This is debate round ${round}/${state.maxDebateRounds}.`,
    role.id === "yes_researcher"
      ? "Make the strongest evidence-based YES case. Address the NO side's prior claims when present."
      : "Make the strongest evidence-based NO/PASS case. Address the YES side's prior claims.",
    "Finish by calling submit_report.",
    OUTPUT_TOOL_INSTRUCTION,
  ].join("\n\n");
}

function judgePrompt(state: V2GraphState): string {
  return [
    state.context,
    `Analyst reports:\n${formatAnalystReports(state)}`,
    `Debate transcript:\n${formatDebateTranscript(state)}`,
    "Judge the debate on evidence quality, resolution risk, and data gaps. Finish by calling submit_judgement.",
    OUTPUT_TOOL_INSTRUCTION,
  ].join("\n\n");
}

function decisionPrompt(state: V2GraphState): string {
  return [
    state.context,
    `Analyst reports:\n${formatAnalystReports(state)}`,
    `Debate transcript:\n${formatDebateTranscript(state)}`,
    `Judge decision:\n${state.debate?.judgement ?? "(no judgement submitted)"}`,
    "Submit a calibrated final decision. If edge is weak or data quality is poor, PASS. Finish by calling submit_verdict.",
    OUTPUT_TOOL_INSTRUCTION,
  ].join("\n\n");
}

function buildGraph(opts: {
  market: UnifiedMarket;
  allMarkets?: UnifiedMarket[];
  marketP: number;
  onProgress?: OrchestrateV2Options["onProgress"];
}) {
  const firstAnalyst = V2_ANALYSTS[0];
  if (!firstAnalyst) throw new Error("v2 graph has no analyst start node");
  const firstDebater = V2_DEBATE_PARTICIPANTS[0];
  const secondDebater = V2_DEBATE_PARTICIPANTS[1];
  const debateRouterId = "debate_router";

  const analystNodes: GraphNode<V2GraphState>[] = V2_ANALYSTS.map((role) => ({
    id: role.id,
    async run({ state }) {
      await runReportNode({
        state,
        role,
        reportKey: role.id,
        progressLabel: role.label,
        prompt: analystPrompt(state),
        market: opts.market,
        allMarkets: opts.allMarkets,
        marketP: opts.marketP,
        onProgress: opts.onProgress,
      });
    },
  }));

  const debateNode = (role: RoleConfig): GraphNode<V2GraphState> => ({
    id: role.id,
    async run({ state }) {
      const round = state.debateRound + 1;
      const reportKey = `${role.id}_round_${round}`;
      const progressLabel = `${role.label} · round ${round}`;
      const report = await runReportNode({
        state,
        role,
        reportKey,
        progressLabel,
        prompt: debatePrompt(state, role, round),
        market: opts.market,
        allMarkets: opts.allMarkets,
        marketP: opts.marketP,
        onProgress: opts.onProgress,
      });

      state.debateLog.push(`[Round ${round} · ${role.label}]\n${report}`);
      if (role.id === noResearcherV2.id) {
        state.debateRound += 1;
        state.debate = {
          transcript: formatDebateTranscript(state),
          winner: state.debate?.winner ?? "UNCLEAR",
          judgement: state.debate?.judgement ?? "",
        };
      }
    },
  });

  const routerNode: GraphNode<V2GraphState> = {
    id: debateRouterId,
    async run({ state }) {
      const decision = routeAfterDebate(state);
      state.lastRoute = decision;
      state.routeDecisions.push(decision);
      opts.onProgress?.(
        "Debate Router",
        `round=${decision.round} next=${decision.next}\nreason=${decision.reason}\nsignals=${decision.signals.join(", ") || "none"}`,
      );
    },
  };

  const judgeNode: GraphNode<V2GraphState> = {
    id: debateJudgeV2.id,
    async run({ state }) {
      const result = await runPiAgentNode({
        role: debateJudgeV2,
        prompt: judgePrompt(state),
        tools: pickTools(
          makeTools({
            state,
            market: opts.market,
            allMarkets: opts.allMarkets,
            reportKey: debateJudgeV2.id,
            marketP: opts.marketP,
          }),
          toolNamesFor(debateJudgeV2),
        ),
        onTool: (label, text) => opts.onProgress?.(`${label} · tool`, text),
      });

      if (!state.debate?.judgement) {
        state.debate = {
          transcript: formatDebateTranscript(state),
          winner: winnerFromText(result.text),
          judgement: result.text || "(no judgement submitted)",
        };
      }
      opts.onProgress?.(debateJudgeV2.label, state.debate.judgement);
    },
  };

  const decisionNode: GraphNode<V2GraphState> = {
    id: decisionManagerV2.id,
    async run({ state }) {
      const result = await runPiAgentNode({
        role: decisionManagerV2,
        prompt: decisionPrompt(state),
        tools: pickTools(
          makeTools({
            state,
            market: opts.market,
            allMarkets: opts.allMarkets,
            reportKey: decisionManagerV2.id,
            marketP: opts.marketP,
          }),
          toolNamesFor(decisionManagerV2),
        ),
        onTool: (label, text) => opts.onProgress?.(`${label} · tool`, text),
      });
      opts.onProgress?.(decisionManagerV2.label, state.verdict ? state.verdict.reasoning : result.text);
    },
  };

  const edges: Record<string, GraphEdge<V2GraphState>> = {};
  for (const [i, role] of V2_ANALYSTS.entries()) {
    edges[role.id] = V2_ANALYSTS[i + 1]?.id ?? firstDebater.id;
  }
  edges[firstDebater.id] = secondDebater.id;
  edges[secondDebater.id] = debateRouterId;
  edges[debateRouterId] = ({ state }: { state: V2GraphState }) =>
    state.lastRoute?.next ?? debateJudgeV2.id;
  edges[debateJudgeV2.id] = decisionManagerV2.id;
  edges[decisionManagerV2.id] = undefined;

  return {
    start: firstAnalyst.id,
    nodes: [...analystNodes, debateNode(firstDebater), debateNode(secondDebater), routerNode, judgeNode, decisionNode],
    edges,
    maxSteps: V2_ANALYSTS.length + V2_MAX_DEBATE_ROUNDS * (V2_DEBATE_PARTICIPANTS.length + 1) + 2,
  };
}

export async function analyzeV2(market: UnifiedMarket, opts: OrchestrateV2Options = {}): Promise<AnalysisState> {
  const marketP = yesProbability(market) ?? 0.5;
  const state: V2GraphState = {
    market,
    marketP,
    context: formatContext(market, marketP),
    reports: {},
    debateRound: 0,
    minDebateRounds: V2_MIN_DEBATE_ROUNDS,
    maxDebateRounds: V2_MAX_DEBATE_ROUNDS,
    debateLog: [],
    reportSubmissions: {},
    routeDecisions: [],
  };

  await runGraph(
    buildGraph({
      market,
      allMarkets: opts.allMarkets,
      marketP,
      onProgress: opts.onProgress,
    }),
    state,
  );

  return state;
}
