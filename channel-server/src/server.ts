import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { broadcastSSE } from "./http.js";
import type {
  ExecuteStatePayload,
  PickTransitionPayload,
} from "./types.js";

export function createChannelServer(): Server {
  const server = new Server(
    { name: "agent-flow", version: "0.1.0" },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
        tools: {},
      },
      instructions:
        "You are connected to the Agent Flow workflow orchestrator. " +
        "Events arrive as <channel source=\"agent-flow\"> tags with workflow state instructions. " +
        "Execute the requested actions, then call report_action_complete with your results. " +
        "When asked to pick a transition, call pick_transition with your choice.",
    }
  );

  // Register tools Claude can call
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "report_action_complete",
        description:
          "Report that you have finished executing the actions for a workflow state. " +
          "Include a summary of what you did and the results.",
        inputSchema: {
          type: "object" as const,
          properties: {
            session_id: { type: "string", description: "The workflow session ID" },
            state_id: { type: "string", description: "The state ID that was executed" },
            results: { type: "string", description: "Summary of execution results" },
          },
          required: ["session_id", "state_id", "results"],
        },
      },
      {
        name: "pick_transition",
        description:
          "Choose which transition to take after evaluating the available options. " +
          "Pick the most appropriate next state based on the current results.",
        inputSchema: {
          type: "object" as const,
          properties: {
            session_id: { type: "string", description: "The workflow session ID" },
            state_id: { type: "string", description: "The current state ID" },
            picked: { type: "string", description: "The target state ID to transition to" },
            reason: { type: "string", description: "Why this transition was chosen" },
          },
          required: ["session_id", "state_id", "picked", "reason"],
        },
      },
    ],
  }));

  // Handle tool calls from Claude
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const typedArgs = args as Record<string, string>;

    if (name === "report_action_complete") {
      broadcastSSE({
        type: "action_complete",
        data: {
          sessionId: typedArgs.session_id,
          stateId: typedArgs.state_id,
          results: typedArgs.results,
        },
      });
      return { content: [{ type: "text", text: "Action completion recorded." }] };
    }

    if (name === "pick_transition") {
      broadcastSSE({
        type: "transition_picked",
        data: {
          sessionId: typedArgs.session_id,
          stateId: typedArgs.state_id,
          picked: typedArgs.picked,
          reason: typedArgs.reason,
        },
      });
      return { content: [{ type: "text", text: `Transitioning to: ${typedArgs.picked}` }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  return server;
}

// Send a channel notification to Claude
export async function sendExecuteState(
  server: Server,
  payload: ExecuteStatePayload
): Promise<void> {
  const actionsText = payload.actions
    .map((a, i) => {
      const prefix = a.type === "prompt" ? "Prompt" : `Script (${a.shell ?? "bash"})`;
      const agent = a.agent ? ` [agent: ${a.agent}]` : "";
      return `${i + 1}. ${prefix}${agent}: ${a.content}`;
    })
    .join("\n");

  const content =
    `Execute workflow state "${payload.stateName}" (id: ${payload.stateId}).\n\n` +
    `Session ID: ${payload.sessionId}\n\n` +
    `Actions to perform${payload.subagent ? " (run as subagents)" : ""}:\n${actionsText}\n\n` +
    `When done, call the report_action_complete tool with session_id="${payload.sessionId}" and state_id="${payload.stateId}".`;

  await server.notification({
    method: "notifications/claude/channel",
    params: {
      content,
      meta: {
        type: "execute_state",
        session_id: payload.sessionId,
        state_id: payload.stateId,
        state_name: payload.stateName,
      },
    },
  });
}

export async function sendPickTransition(
  server: Server,
  payload: PickTransitionPayload
): Promise<void> {
  const optionsText = payload.options
    .map((o, i) => `${i + 1}. Go to "${o.to}" — ${o.description}`)
    .join("\n");

  const content =
    `Choose the next transition for state "${payload.stateId}".\n\n` +
    `Session ID: ${payload.sessionId}\n\n` +
    `Available transitions:\n${optionsText}\n\n` +
    `Based on what you just did, pick the most appropriate transition. ` +
    `Call the pick_transition tool with session_id="${payload.sessionId}", ` +
    `state_id="${payload.stateId}", and the picked target state ID.`;

  await server.notification({
    method: "notifications/claude/channel",
    params: {
      content,
      meta: {
        type: "pick_transition",
        session_id: payload.sessionId,
        state_id: payload.stateId,
      },
    },
  });
}
