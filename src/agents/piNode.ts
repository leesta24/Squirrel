import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { RoleConfig } from "./types.js";
import { createPiNodeRuntime } from "./llm.js";

export interface PiNodeProgress {
  role: RoleConfig;
  event: AgentEvent;
}

export interface RunPiNodeOptions {
  role: RoleConfig;
  prompt: string;
  tools: AgentTool[];
  onText?: (label: string, text: string) => void;
  onTool?: (label: string, text: string) => void;
  onEvent?: (progress: PiNodeProgress) => void;
}

function textFromMessages(messages: AgentMessage[]): string {
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  if (!lastAssistant || !("content" in lastAssistant) || !Array.isArray(lastAssistant.content)) return "";
  return lastAssistant.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export async function runPiAgentNode(opts: RunPiNodeOptions): Promise<{ text: string; messages: AgentMessage[] }> {
  const runtime = createPiNodeRuntime(opts.role.tier);
  const agent = new Agent({
    initialState: {
      systemPrompt: opts.role.systemPrompt,
      model: runtime.model,
      tools: opts.tools,
      thinkingLevel: "off",
    },
    streamFn: runtime.streamFn,
    toolExecution: "parallel",
  });

  let streamed = "";
  agent.subscribe((event) => {
    opts.onEvent?.({ role: opts.role, event });
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent as { type?: string; delta?: string };
      if (update.type === "text_delta" && update.delta) {
        streamed += update.delta;
        opts.onText?.(opts.role.label, update.delta);
      }
    }
    if (event.type === "tool_execution_start") {
      opts.onTool?.(opts.role.label, `tool_start ${event.toolName} ${JSON.stringify(event.args)}`);
    }
    if (event.type === "tool_execution_end") {
      opts.onTool?.(opts.role.label, `tool_end ${event.toolName} ${event.isError ? "ERROR" : "OK"}`);
    }
  });

  await agent.prompt(opts.prompt);
  const messages = agent.state.messages;
  return { text: streamed || textFromMessages(messages), messages };
}
