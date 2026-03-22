import type { Node, Edge } from "@xyflow/react";
import { MarkerType } from "@xyflow/react";
import { layoutGraph } from "./layout";
import type { NodeTypes } from "@xyflow/react";
import StateNode from "./StateNode";
import type { WorkflowState, Transition, StateNodeData } from "./types";

export const nodeTypes: NodeTypes = {
  state: StateNode,
};

export function workflowToNodes(states: WorkflowState[], edges?: Edge[]): Node[] {
  const nodes = states.map((state) => ({
    id: state.id,
    type: "state",
    position: state.position ?? { x: 0, y: 0 },
    data: { state } as StateNodeData,
  }));

  const needsLayout = states.some((s) => !s.position);
  if (needsLayout && edges) {
    return layoutGraph(nodes, edges);
  }
  return nodes;
}

// Compute topological rank once for all transitions — O(V + E)
function computeRanks(transitions: Transition[]): Map<string, number> {
  const visited = new Set<string>();
  const order: string[] = [];
  const adj = new Map<string, string[]>();

  for (const t of transitions) {
    if (!adj.has(t.from)) adj.set(t.from, []);
    adj.get(t.from)!.push(t.to);
  }

  function dfs(node: string) {
    if (visited.has(node)) return;
    visited.add(node);
    for (const next of adj.get(node) ?? []) dfs(next);
    order.push(node);
  }

  const allNodes = new Set<string>();
  for (const t of transitions) { allNodes.add(t.from); allNodes.add(t.to); }
  for (const n of allNodes) dfs(n);
  order.reverse();

  const rank = new Map<string, number>();
  order.forEach((n, i) => rank.set(n, i));
  return rank;
}

function shortLabel(desc: string): string {
  if (!desc) return "";
  const words = desc.split(/\s+/);
  if (words.length <= 4) return desc;
  return words.slice(0, 4).join(" ") + "...";
}

export function transitionsToEdges(transitions: Transition[]): Edge[] {
  const ranks = computeRanks(transitions);

  return transitions.map((t, i) => {
    const isLoop = (ranks.get(t.to) ?? 0) < (ranks.get(t.from) ?? 0);
    return {
      id: `e-${t.from}-${t.to}-${i}`,
      source: t.from,
      target: t.to,
      label: shortLabel(t.description),
      type: "smoothstep",
      animated: isLoop,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: {
        stroke: isLoop ? "#d29922" : "#58a6ff",
        strokeDasharray: isLoop ? "6 3" : undefined,
      },
      labelStyle: { fill: isLoop ? "#d29922" : "#8b949e", fontSize: 11 },
      labelBgStyle: { fill: "#0d1117", fillOpacity: 0.9 },
      labelBgPadding: [6, 6] as [number, number],
      labelBgBorderRadius: 4,
      data: { fullDescription: t.description },
    };
  });
}
