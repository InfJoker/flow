import Dagre from "@dagrejs/dagre";
import type { Node, Edge } from "@xyflow/react";

export function layoutGraph(nodes: Node[], edges: Edge[]): Node[] {
  const g = new Dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));

  g.setGraph({
    rankdir: "LR",
    nodesep: 80,
    ranksep: 200,
    edgesep: 40,
  });

  nodes.forEach((node) => {
    g.setNode(node.id, { width: 240, height: 100 });
  });

  edges.forEach((edge) => {
    g.setEdge(edge.source, edge.target);
  });

  Dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: {
        x: pos.x - 120,
        y: pos.y - 50,
      },
    };
  });
}
