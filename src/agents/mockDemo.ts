// Mock demo responder — drives the orchestration without an API key, to verify the legacy pipeline works.
// Returns reasonable placeholder output based on each role's systemPrompt.

import type { MockResponder } from "./llm.js";

export const demoResponder: MockResponder = ({ systemPrompt, structured }) => {
  if (structured) {
    if (/Estimator/i.test(systemPrompt)) {
      return { pHat: 0.42, reasoning: "[mock] Lowered to 0.42 after combining the base rate and the news." };
    }
    if (/Risk Manager/i.test(systemPrompt)) {
      return { kellyFraction: 0.06, recommendation: "BET NO", reasoning: "[mock] Resolution risk is elevated; halving the size." };
    }
    return {};
  }
  if (/Base-Rate/i.test(systemPrompt)) return "[mock] Reference-class historical base rate is about 35%.";
  if (/News Analyst/i.test(systemPrompt)) return "[mock] No major recent catalyst; probability dips slightly.";
  if (/Microstructure/i.test(systemPrompt)) return "[mock] Thin orderbook; no significant cross-platform spread.";
  if (/Resolution-Risk/i.test(systemPrompt)) return "[mock] Settlement source is clear. Risk level: MEDIUM";
  if (/YES Researcher/i.test(systemPrompt)) return "[mock] Supports YES: recent trend is favorable.";
  if (/NO Researcher/i.test(systemPrompt)) return "[mock] Supports NO: low base rate and lacking catalysts.";
  if (/Research Manager/i.test(systemPrompt)) return "WINNER: NO\n[mock] The NO side made the more solid case.";
  return "[mock] (generic)";
};
