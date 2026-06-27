// LLM abstraction layer — one interface, three backends, so the orchestrator never
// cares which model provider is wired (PLAN §5: "swap provider via config, not code").
//
//   1. Vercel AI Gateway (AI_GATEWAY_API_KEY)  — one key for many providers, cost tracking, failover
//   2. Direct Anthropic   (ANTHROPIC_API_KEY)  — fallback when no gateway key
//   3. Mock               (createMockLLM)      — no key, validates orchestration logic
//
// Both real backends speak the Anthropic Messages protocol (the gateway exposes it too), so
// structured output uses the same toolChoice {type:"tool",name} and both read their key from env.
//
// Each call builds a FRESH models instance: reusing one instance across many calls left the
// tools/toolChoice off later requests (the model then hand-wrote a fake <tool_call> in text
// instead of a real tool_use). Provider construction is cheap (built-in model list), so this is fine.

import { createModels, type Api, type Model } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { vercelAIGatewayProvider } from "@earendil-works/pi-ai/providers/vercel-ai-gateway";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Tier, StructuredTool } from "./types.js";

// Model ids per backend. Override with MODEL_DEEP / MODEL_QUICK env vars.
// Gateway slugs use dots (anthropic/claude-…-4.x); confirm current ids via the gateway model list.
const MODELS = {
  gateway: {
    deep: process.env.MODEL_DEEP ?? "anthropic/claude-opus-4.8",
    quick: process.env.MODEL_QUICK ?? "anthropic/claude-haiku-4.5",
  },
  anthropic: {
    deep: process.env.MODEL_DEEP ?? "claude-opus-4-8",
    quick: process.env.MODEL_QUICK ?? "claude-haiku-4-5",
  },
};

export interface LLM {
  mock: boolean;
  /** free-form reasoning */
  text(tier: Tier, systemPrompt: string, userPrompt: string): Promise<string>;
  /** structured output: forces the model to return tool.parameters' schema */
  structured<T>(tier: Tier, systemPrompt: string, userPrompt: string, tool: StructuredTool): Promise<T>;
}

const textOf = (content: { type: string; text?: string }[]): string =>
  content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");

function userCtx(systemPrompt: string, userPrompt: string) {
  return {
    systemPrompt,
    messages: [{ role: "user" as const, content: userPrompt, timestamp: Date.now() }],
  };
}

/** A backend yields a fresh (models, model-picker) pair per call. */
type Backend = () => { models: ReturnType<typeof createModels>; pick: (tier: Tier) => unknown };

function makeLLM(backend: Backend): LLM {
  return {
    mock: false,
    async text(tier, systemPrompt, userPrompt) {
      const { models, pick } = backend();
      const res = await models.completeSimple(
        pick(tier) as never,
        userCtx(systemPrompt, userPrompt) as never,
        { maxTokens: 1400 } as never,
      );
      return textOf(res.content);
    },
    async structured<T>(tier: Tier, systemPrompt: string, userPrompt: string, tool: StructuredTool) {
      const { models, pick } = backend();
      // tools belong in the context (2nd arg); toolChoice/maxTokens are options (3rd arg).
      // Putting tools in options silently drops them — the request ships toolChoice with no
      // tool list, the API degrades to free text, and the model hallucinates a fake tool call.
      const res = await models.complete(
        pick(tier) as never,
        { ...userCtx(systemPrompt, userPrompt), tools: [tool] } as never,
        { toolChoice: { type: "tool", name: tool.name }, maxTokens: 4000, reasoning: "off" } as never,
      );
      const call = (res.content as { type: string; arguments?: unknown }[]).find(
        (c) => c.type === "toolCall",
      );
      if (!call?.arguments) throw new Error(`structured output failed: ${tool.name}`);
      return call.arguments as T;
    },
  };
}

function pickerFor(pool: readonly { id: string }[], ids: Record<Tier, string>) {
  return (tier: Tier) => {
    const m = pool.find((x) => x.id === ids[tier]);
    if (!m) throw new Error(`model not found: ${ids[tier]}`);
    return m;
  };
}

export interface PiNodeRuntime {
  model: Model<Api>;
  streamFn: StreamFn;
}

function piRuntimeFor(provider: ReturnType<typeof vercelAIGatewayProvider> | ReturnType<typeof anthropicProvider>, tier: Tier, ids: Record<Tier, string>): PiNodeRuntime {
  const models = createModels();
  models.setProvider(provider);
  const model = pickerFor(provider.getModels(), ids)(tier) as Model<Api>;
  return {
    model,
    streamFn: (m, context, options) => models.streamSimple(m, context, options) as never,
  };
}

/** Runtime for a real Pi Agent node. The graph layer owns orchestration; Pi owns tool-call loops. */
export function createPiNodeRuntime(tier: Tier): PiNodeRuntime {
  if (process.env.AI_GATEWAY_API_KEY) return piRuntimeFor(vercelAIGatewayProvider(), tier, MODELS.gateway);
  if (process.env.ANTHROPIC_API_KEY) return piRuntimeFor(anthropicProvider(), tier, MODELS.anthropic);
  throw new Error("Set AI_GATEWAY_API_KEY (Vercel AI Gateway) or ANTHROPIC_API_KEY.");
}

function gatewayLLM(): LLM {
  return makeLLM(() => {
    const provider = vercelAIGatewayProvider(); // reads AI_GATEWAY_API_KEY
    const models = createModels();
    models.setProvider(provider);
    return { models, pick: pickerFor(provider.getModels(), MODELS.gateway) };
  });
}

function anthropicLLM(): LLM {
  return makeLLM(() => {
    const provider = anthropicProvider(); // reads ANTHROPIC_API_KEY
    const models = createModels();
    models.setProvider(provider);
    return { models, pick: pickerFor(provider.getModels(), MODELS.anthropic) };
  });
}

/** Real LLM. Prefers Vercel AI Gateway, falls back to direct Anthropic. */
export function createLLM(): LLM {
  if (process.env.AI_GATEWAY_API_KEY) return gatewayLLM();
  if (process.env.ANTHROPIC_API_KEY) return anthropicLLM();
  throw new Error("Set AI_GATEWAY_API_KEY (Vercel AI Gateway) or ANTHROPIC_API_KEY.");
}

/** responder returns preset text (text) or object (structured) per request */
export type MockResponder = (req: {
  tier: Tier;
  systemPrompt: string;
  userPrompt: string;
  structured: boolean;
}) => string | Record<string, unknown>;

/**
 * Mock impl (no API key) for validating orchestration logic. Short-circuits the responder
 * directly instead of going through Pi's mock provider — the latter is a shared queue and
 * parallel analyst calls (Promise.all) would clobber each other. Pi integration is exercised
 * by the real backends.
 */
export function createMockLLM(responder: MockResponder): LLM {
  return {
    mock: true,
    async text(tier, systemPrompt, userPrompt) {
      const out = responder({ tier, systemPrompt, userPrompt, structured: false });
      return typeof out === "string" ? out : JSON.stringify(out);
    },
    async structured<T>(tier: Tier, systemPrompt: string, userPrompt: string, _tool: StructuredTool) {
      const out = responder({ tier, systemPrompt, userPrompt, structured: true });
      return (typeof out === "string" ? {} : out) as T;
    },
  };
}
