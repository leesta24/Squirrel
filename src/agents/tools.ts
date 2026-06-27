import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import * as polymarket from "../data/polymarket.js";
import * as kalshi from "../data/kalshi.js";
import { fetchJson } from "../data/http.js";
import type { UnifiedMarket } from "../data/types.js";
import { yesProbability } from "../data/types.js";
import { findArbitrage } from "../analysis/arbitrage.js";

const CLOB = "https://clob.polymarket.com";
const KALSHI = "https://external-api.kalshi.com/trade-api/v2";

export interface ReportSubmission {
  summary: string;
  keySignals: string[];
  risks: string[];
  confidence: number;
  dataGaps: string[];
}

export interface VerdictSubmission {
  side: "YES" | "NO" | "PASS";
  pHat: number;
  action: string;
  size: number;
  reasoning: string;
  dataGaps: string[];
}

export interface JudgementSubmission {
  winner: "YES" | "NO" | "UNCLEAR";
  reasoning: string;
  strongestYesClaims: string[];
  strongestNoClaims: string[];
  dataGaps: string[];
}

export interface PredictionToolContext {
  market: UnifiedMarket;
  allMarkets?: UnifiedMarket[];
  roleId?: string;
  onReport?: (roleId: string, report: ReportSubmission) => void;
  onJudgement?: (judgement: JudgementSubmission) => void;
  onVerdict?: (verdict: VerdictSubmission) => void;
}

function textResult<T>(details: T, terminate = false): AgentToolResult<T> {
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details,
    terminate,
  };
}

function clamp01(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function embeddedParam(summary: string, name: string): unknown {
  const match = summary.match(new RegExp(`<parameter\\s+name=["']${name}["']>([\\s\\S]*?)</parameter>`, "i"));
  if (!match?.[1]) return undefined;
  const raw = match[1].trim();
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function cleanSummary(summary: string): string {
  return summary.replace(/<\/parameter>[\s\S]*$/i, "").trim();
}

function normalizeReport(params: unknown): ReportSubmission {
  const raw = params as Partial<ReportSubmission>;
  const summaryText = typeof raw.summary === "string" ? raw.summary : "";
  const summary = cleanSummary(summaryText) || "Report submitted.";
  return {
    summary,
    keySignals: asStringArray(raw.keySignals).length
      ? asStringArray(raw.keySignals)
      : asStringArray(embeddedParam(summaryText, "keySignals")),
    risks: asStringArray(raw.risks).length
      ? asStringArray(raw.risks)
      : asStringArray(embeddedParam(summaryText, "risks")),
    confidence: clamp01(raw.confidence ?? embeddedParam(summaryText, "confidence"), 0.5),
    dataGaps: asStringArray(raw.dataGaps).length
      ? asStringArray(raw.dataGaps)
      : asStringArray(embeddedParam(summaryText, "dataGaps")),
  };
}

function now() {
  return new Date().toISOString();
}

function summarizeMarket(m: UnifiedMarket) {
  return {
    source: m.source,
    id: m.id,
    question: m.question,
    yesProbability: yesProbability(m),
    outcomes: m.outcomes,
    volume: m.volume,
    liquidity: m.liquidity,
    openInterest: m.openInterest,
    priceChange24h: m.priceChange24h,
    closeTime: m.closeTime,
    description: m.description,
    resolution: m.resolution,
  };
}

function matches(m: UnifiedMarket, query: string | undefined) {
  if (!query) return true;
  const q = query.toLowerCase();
  return m.id.toLowerCase() === q || m.question.toLowerCase().includes(q);
}

function currentTokenId(ctx: PredictionToolContext): string | undefined {
  return ctx.market.outcomes[0]?.tokenId;
}

function currentTicker(ctx: PredictionToolContext): string | undefined {
  return ctx.market.source === "kalshi" ? ctx.market.id : undefined;
}

export function createPredictionMarketTools(ctx: PredictionToolContext): AgentTool[] {
  const roleId = ctx.roleId ?? "agent";

  const polymarketSearch: AgentTool = {
    name: "polymarket_search_markets",
    label: "Search Polymarket",
    description: "Search active Polymarket markets by question text.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Substring to match in the market question" })),
      limit: Type.Optional(Type.Number({ description: "Maximum markets to fetch before filtering", minimum: 1, maximum: 200 })),
    }),
    async execute(_toolCallId, params) {
      const p = params as { query?: string; limit?: number };
      const markets = await polymarket.fetchMarkets(p.limit ?? 80);
      return textResult({
        source: "polymarket",
        timestamp: now(),
        markets: markets.filter((m) => matches(m, p.query)).slice(0, 20).map(summarizeMarket),
        dataGaps: [],
      });
    },
  };

  const kalshiSearch: AgentTool = {
    name: "kalshi_search_markets",
    label: "Search Kalshi",
    description: "Search open Kalshi markets by question text.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Substring to match in the market question" })),
      limit: Type.Optional(Type.Number({ description: "Maximum markets to fetch before filtering", minimum: 1, maximum: 300 })),
    }),
    async execute(_toolCallId, params) {
      const p = params as { query?: string; limit?: number };
      const markets = await kalshi.fetchMarkets(p.limit ?? 160);
      return textResult({
        source: "kalshi",
        timestamp: now(),
        markets: markets.filter((m) => matches(m, p.query)).slice(0, 20).map(summarizeMarket),
        dataGaps: [],
      });
    },
  };

  const verifiedSnapshot: AgentTool = {
    name: "get_verified_market_snapshot",
    label: "Verified Market Snapshot",
    description: "Return the normalized current market snapshot for the target market.",
    parameters: Type.Object({}),
    async execute() {
      const gaps = [];
      if (!ctx.market.description) gaps.push("settlement_rules_missing_or_partial");
      if (ctx.market.source === "polymarket" && !currentTokenId(ctx)) gaps.push("polymarket_yes_token_id_missing");
      return textResult({
        source: ctx.market.source,
        timestamp: now(),
        market: summarizeMarket(ctx.market),
        dataGaps: gaps,
      });
    },
  };

  const probabilityIndicators: AgentTool = {
    name: "get_probability_indicators",
    label: "Probability Indicators",
    description: "Compute prediction-market indicators from the normalized market snapshot.",
    parameters: Type.Object({}),
    async execute() {
      const yes = ctx.market.outcomes[0];
      const bid = yes?.bid;
      const ask = yes?.ask;
      const spread = bid !== undefined && ask !== undefined ? Math.max(0, ask - bid) : undefined;
      const volume = ctx.market.volume ?? 0;
      const liquidity = ctx.market.liquidity ?? 0;
      return textResult({
        source: ctx.market.source,
        timestamp: now(),
        indicators: {
          yesProbability: yesProbability(ctx.market),
          priceChange24h: ctx.market.priceChange24h,
          bidAskSpread: spread,
          volume,
          liquidity,
          volumeLiquidityRatio: liquidity > 0 ? volume / liquidity : undefined,
          extremeProbability:
            yesProbability(ctx.market) !== undefined
              ? yesProbability(ctx.market)! <= 0.05 || yesProbability(ctx.market)! >= 0.95
              : undefined,
        },
        dataGaps: [
          ...(ctx.market.priceChange24h === undefined ? ["24h_probability_change_missing"] : []),
          ...(spread === undefined ? ["bid_ask_spread_missing"] : []),
        ],
      });
    },
  };

  const polymarketOrderbook: AgentTool = {
    name: "polymarket_get_orderbook",
    label: "Polymarket Orderbook",
    description: "Fetch the Polymarket CLOB orderbook for the target YES token.",
    parameters: Type.Object({
      tokenId: Type.Optional(Type.String({ description: "Polymarket CLOB token id; defaults to target market YES token" })),
    }),
    async execute(_toolCallId, params) {
      const tokenId = (params as { tokenId?: string }).tokenId ?? currentTokenId(ctx);
      if (!tokenId) {
        return textResult({ source: "polymarket", timestamp: now(), orderbook: null, dataGaps: ["token_id_missing"] });
      }
      try {
        const orderbook = await fetchJson<unknown>(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`);
        return textResult({ source: "polymarket", timestamp: now(), tokenId, orderbook, dataGaps: [] });
      } catch (error) {
        return textResult({ source: "polymarket", timestamp: now(), tokenId, orderbook: null, error: String(error), dataGaps: ["orderbook_unavailable"] });
      }
    },
  };

  const kalshiOrderbook: AgentTool = {
    name: "kalshi_get_orderbook",
    label: "Kalshi Orderbook",
    description: "Fetch the Kalshi orderbook for the target ticker.",
    parameters: Type.Object({
      ticker: Type.Optional(Type.String({ description: "Kalshi market ticker; defaults to target market ticker" })),
    }),
    async execute(_toolCallId, params) {
      const ticker = (params as { ticker?: string }).ticker ?? currentTicker(ctx);
      if (!ticker) {
        return textResult({ source: "kalshi", timestamp: now(), orderbook: null, dataGaps: ["ticker_missing_or_target_not_kalshi"] });
      }
      try {
        const orderbook = await fetchJson<unknown>(`${KALSHI}/markets/${encodeURIComponent(ticker)}/orderbook`);
        return textResult({ source: "kalshi", timestamp: now(), ticker, orderbook, dataGaps: [] });
      } catch (error) {
        return textResult({ source: "kalshi", timestamp: now(), ticker, orderbook: null, error: String(error), dataGaps: ["orderbook_unavailable"] });
      }
    },
  };

  const crossPlatformSignals: AgentTool = {
    name: "get_cross_platform_anomaly_signals",
    label: "Cross-platform Signals",
    description: "Find likely related Polymarket/Kalshi markets and report probability-spread anomaly candidates.",
    parameters: Type.Object({}),
    async execute() {
      const markets = ctx.allMarkets ?? [ctx.market];
      const signals = findArbitrage(markets, { limit: 10 }).map((s) => ({
        polymarket: summarizeMarket(s.pm),
        kalshi: summarizeMarket(s.kalshi),
        similarity: s.similarity,
        polymarketYes: s.pmYes,
        kalshiYes: s.kalshiYes,
        spreadPp: s.spreadPp,
      }));
      return textResult({
        timestamp: now(),
        signals,
        dataGaps: signals.length === 0 ? ["no_cross_platform_match_above_threshold"] : ["direction_and_resolution_comparability_unverified"],
      });
    },
  };

  const submitReport: AgentTool = {
    name: "submit_report",
    label: "Submit Report",
    description: "Submit this agent's structured analysis report and finish the current node.",
    parameters: Type.Object({
      summary: Type.String({ description: "Concise report summary" }),
      keySignals: Type.Optional(Type.Array(Type.String(), { description: "Key evidence or signals" })),
      risks: Type.Optional(Type.Array(Type.String(), { description: "Important risks or caveats" })),
      confidence: Type.Optional(Type.Number({ description: "Confidence from 0 to 1", minimum: 0, maximum: 1 })),
      dataGaps: Type.Optional(Type.Array(Type.String(), { description: "Missing or partial data that limits confidence" })),
    }),
    async execute(_toolCallId, params) {
      const report = normalizeReport(params);
      ctx.onReport?.(roleId, report);
      return textResult({ roleId, report }, true);
    },
  };

  const submitJudgement: AgentTool = {
    name: "submit_judgement",
    label: "Submit Debate Judgement",
    description: "Submit the debate judge's structured winner and reasoning, then finish the node.",
    parameters: Type.Object({
      winner: Type.String({ description: "YES, NO, or UNCLEAR" }),
      reasoning: Type.String({ description: "Why this side won the debate, or why the debate is inconclusive" }),
      strongestYesClaims: Type.Array(Type.String(), { description: "Best arguments made by the YES researcher" }),
      strongestNoClaims: Type.Array(Type.String(), { description: "Best arguments made by the NO researcher" }),
      dataGaps: Type.Array(Type.String(), { description: "Missing or partial data that limits confidence" }),
    }),
    async execute(_toolCallId, params) {
      const raw = params as Omit<JudgementSubmission, "winner"> & { winner: string };
      const normalized = String(raw.winner).toUpperCase();
      const winner: JudgementSubmission["winner"] =
        normalized === "YES" || normalized === "NO" ? normalized : "UNCLEAR";
      const judgement: JudgementSubmission = { ...raw, winner };
      ctx.onJudgement?.(judgement);
      return textResult({ judgement }, true);
    },
  };

  const submitVerdict: AgentTool = {
    name: "submit_verdict",
    label: "Submit Verdict",
    description: "Submit the final structured market decision and finish the graph.",
    parameters: Type.Object({
      side: Type.String({ description: "YES, NO, or PASS" }),
      pHat: Type.Number({ description: "Estimated true YES probability, 0..1", minimum: 0, maximum: 1 }),
      action: Type.String({ description: "Short action such as BET YES, BET NO, or PASS" }),
      size: Type.Number({ description: "Suggested position as fraction of bankroll, 0..1", minimum: 0, maximum: 1 }),
      reasoning: Type.String({ description: "Concise justification" }),
      dataGaps: Type.Array(Type.String(), { description: "Missing or partial data that limits confidence" }),
    }),
    async execute(_toolCallId, params) {
      const raw = params as Omit<VerdictSubmission, "side"> & { side: string };
      const normalized = String(raw.side).toUpperCase();
      const side: VerdictSubmission["side"] =
        normalized === "YES" || normalized === "NO" ? normalized : "PASS";
      const verdict: VerdictSubmission = { ...raw, side };
      ctx.onVerdict?.(verdict);
      return textResult({ verdict }, true);
    },
  };

  return [
    polymarketSearch,
    kalshiSearch,
    verifiedSnapshot,
    probabilityIndicators,
    polymarketOrderbook,
    kalshiOrderbook,
    crossPlatformSignals,
    submitReport,
    submitJudgement,
    submitVerdict,
  ];
}

export function pickTools(tools: AgentTool[], names: string[]): AgentTool[] {
  const allowed = new Set(names);
  return tools.filter((tool) => allowed.has(tool.name));
}
