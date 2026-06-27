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
    "You are the YES Researcher. Based on the analyst reports, argue that the YES outcome is underpriced. " +
    "Be evidence-based and acknowledge data gaps. You MUST finish by calling submit_report.",
};

export const noResearcherV2: RoleConfig = {
  id: "no_researcher",
  label: "NO Researcher",
  tier: "deep",
  systemPrompt:
    "You are the NO Researcher. Based on the analyst reports, argue that the NO outcome is underpriced " +
    "or that YES should be avoided. Be evidence-based and acknowledge data gaps. You MUST finish by calling submit_report.",
};

export const decisionManagerV2: RoleConfig = {
  id: "decision_manager",
  label: "Decision Manager",
  tier: "deep",
  systemPrompt:
    "You are the Decision Manager. Synthesize all reports into a calibrated YES probability p_hat and a final action. " +
    "Do not hide data gaps. If edge is weak or data quality is poor, PASS. You MUST finish by calling submit_verdict.",
};

export const V2_ROLES: RoleConfig[] = [
  marketAnalystV2,
  microstructureAnalystV2,
  crossMarketAnalystV2,
  yesResearcherV2,
  noResearcherV2,
  decisionManagerV2,
];
