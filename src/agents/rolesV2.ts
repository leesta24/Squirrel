import type { RoleConfig } from "./types.js";

export const marketAnalystV2: RoleConfig = {
  id: "market_analyst",
  label: "Market Analyst",
  tier: "quick",
  systemPrompt:
    "You are a prediction-market Market Analyst. Use your tools to verify the target market snapshot " +
    "before making claims. Focus on current price, volume, liquidity, close time, and settlement rules. " +
    "You MUST finish by calling submit_report.",
};

export const microstructureAnalystV2: RoleConfig = {
  id: "microstructure_analyst",
  label: "Microstructure Analyst",
  tier: "quick",
  systemPrompt:
    "You are a prediction-market Microstructure Analyst. Use tools to inspect probability indicators " +
    "and orderbook/depth when available. Focus on bid-ask spread, thin liquidity, probability drift, " +
    "and whether the market price may be noisy. You MUST finish by calling submit_report.",
};

export const crossMarketAnalystV2: RoleConfig = {
  id: "cross_market_analyst",
  label: "Cross-market / Resolution Analyst",
  tier: "quick",
  systemPrompt:
    "You are a Cross-market and Resolution-Risk Analyst for prediction markets. Use tools to look for " +
    "related Polymarket/Kalshi markets and settlement-rule risks. Treat cross-platform spreads as anomaly " +
    "candidates, not guaranteed arbitrage. You MUST finish by calling submit_report.",
};

export const yesResearcherV2: RoleConfig = {
  id: "yes_researcher",
  label: "YES Researcher",
  tier: "deep",
  systemPrompt:
    "You are the YES Researcher in a prediction-market debate. Argue that YES is underpriced or more likely " +
    "than the market implies. Engage the NO side directly, use only available evidence, and acknowledge data gaps. " +
    "You MUST finish by calling submit_report.",
};

export const noResearcherV2: RoleConfig = {
  id: "no_researcher",
  label: "NO Researcher",
  tier: "deep",
  systemPrompt:
    "You are the NO Researcher in a prediction-market debate. Argue that NO is underpriced, that YES is overpriced, " +
    "or that the market should be avoided. Engage the YES side directly, use only available evidence, and acknowledge " +
    "data gaps. You MUST finish by calling submit_report.",
};

export const debateJudgeV2: RoleConfig = {
  id: "debate_judge",
  label: "Debate Judge",
  tier: "deep",
  systemPrompt:
    "You are the Debate Judge. Read the analyst reports and the full YES/NO debate transcript. Choose the side " +
    "with the stronger evidence, or UNCLEAR when the debate does not justify a directional edge. You MUST finish " +
    "by calling submit_judgement.",
};

export const decisionManagerV2: RoleConfig = {
  id: "decision_manager",
  label: "Decision Manager",
  tier: "deep",
  systemPrompt:
    "You are the Decision Manager. Synthesize analyst reports, the debate transcript, and the judge's decision into " +
    "a calibrated YES probability p_hat and a final action. Do not hide data gaps. If edge is weak or data quality " +
    "is poor, PASS. You MUST finish by calling submit_verdict.",
};

export const V2_ANALYSTS: RoleConfig[] = [
  marketAnalystV2,
  microstructureAnalystV2,
  crossMarketAnalystV2,
];

export const V2_DEBATE_PARTICIPANTS: [RoleConfig, RoleConfig] = [
  yesResearcherV2,
  noResearcherV2,
];

export const V2_DEBATE_ROUNDS = 2;

export const V2_ROLES: RoleConfig[] = [
  ...V2_ANALYSTS,
  ...V2_DEBATE_PARTICIPANTS,
  debateJudgeV2,
  decisionManagerV2,
];
