// faux demo responder — drives the orchestration without an API key, to verify the full pipeline works.
// Returns reasonable placeholder output based on each role's systemPrompt (all tagged [faux]).

import type { FauxResponder } from "./llm.js";

export const demoResponder: FauxResponder = ({ systemPrompt, structured }) => {
  if (structured) {
    if (/Estimator/i.test(systemPrompt)) {
      return { pHat: 0.42, reasoning: "[faux] Lowered to 0.42 after combining the base rate and the news." };
    }
    if (/Risk Manager/i.test(systemPrompt)) {
      return { kellyFraction: 0.06, recommendation: "BET NO", reasoning: "[faux] Resolution risk is elevated; halving the size." };
    }
    return {};
  }
  if (/Base-Rate/i.test(systemPrompt)) return "[faux] Reference-class historical base rate is about 35%.";
  if (/News Analyst/i.test(systemPrompt)) return "[faux] No major recent catalyst; probability dips slightly.";
  if (/Microstructure/i.test(systemPrompt)) return "[faux] Thin orderbook; no significant cross-platform spread.";
  if (/Resolution-Risk/i.test(systemPrompt)) return "[faux] Settlement source is clear. Risk level: MEDIUM";
  if (/YES Researcher/i.test(systemPrompt)) return "[faux] Supports YES: recent trend is favorable.";
  if (/NO Researcher/i.test(systemPrompt)) return "[faux] Supports NO: low base rate and lacking catalysts.";
  if (/Research Manager/i.test(systemPrompt)) return "WINNER: NO\n[faux] The NO side made the more solid case.";
  return "[faux] (generic)";
};
