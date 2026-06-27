// Structured-output schema + Kelly position sizing.

import { Type } from "@earendil-works/pi-ai";
import type { StructuredTool } from "./types.js";

/** Estimator output: true-probability estimate */
export const estimateTool: StructuredTool = {
  name: "submit_estimate",
  description: "Submit the calibrated probability estimate for the YES outcome.",
  parameters: Type.Object({
    pHat: Type.Number({ description: "Calibrated true probability of YES, 0..1", minimum: 0, maximum: 1 }),
    reasoning: Type.String({ description: "Brief justification (<80 words)" }),
  }),
};

/** Risk Manager output: final position size and recommendation */
export const riskTool: StructuredTool = {
  name: "submit_decision",
  description: "Submit the final position sizing decision.",
  parameters: Type.Object({
    kellyFraction: Type.Number({ description: "Final position size as fraction of bankroll, 0..1", minimum: 0, maximum: 1 }),
    recommendation: Type.String({ description: "Short action, e.g. 'BET YES' / 'BET NO' / 'PASS'" }),
    reasoning: Type.String({ description: "Brief justification (<80 words)" }),
  }),
};

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export interface KellyResult {
  side: "YES" | "NO" | "PASS";
  edge: number; // pHat - marketP (YES perspective)
  kelly: number; // suggested fractional-Kelly position
}

/**
 * Fractional Kelly for binary contracts.
 * Buy YES (cost marketP, payout 1): f* = (pHat - marketP) / (1 - marketP)
 * Buy NO  (cost 1-marketP, payout 1): f* = (marketP - pHat) / marketP
 * PASS when edge is below threshold (to cover fees + uncertainty).
 */
export function kelly(
  pHat: number,
  marketP: number,
  opts: { fraction?: number; edgeThreshold?: number; cap?: number } = {},
): KellyResult {
  const { fraction = 0.25, edgeThreshold = 0.05, cap = 0.5 } = opts;
  const edge = pHat - marketP;
  if (Math.abs(edge) < edgeThreshold) return { side: "PASS", edge, kelly: 0 };
  if (edge > 0) {
    const f = (pHat - marketP) / (1 - marketP);
    return { side: "YES", edge, kelly: clamp(f * fraction, 0, cap) };
  }
  const f = (marketP - pHat) / marketP;
  return { side: "NO", edge, kelly: clamp(f * fraction, 0, cap) };
}
