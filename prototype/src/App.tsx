import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type OnConnect,
  type Node,
  type Edge,
  BackgroundVariant,
  type NodeTypes,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./App.css";

import StateNode from "./StateNode";
import StatePanel from "./StatePanel";
import { debugWorkflow } from "./mockData";
import { layoutGraph } from "./layout";
import type { WorkflowState, Transition, StateNodeData } from "./types";

const nodeTypes: NodeTypes = {
  state: StateNode,
};

function workflowToNodes(states: WorkflowState[]): Node[] {
  return states.map((state) => ({
    id: state.id,
    type: "state",
    position: { x: 0, y: 0 },
    data: { state } as StateNodeData,
  }));
}

function isLoopBack(from: string, to: string, transitions: Transition[]): boolean {
  // A transition is a loop-back if `to` appears earlier in the topological order
  const visited = new Set<string>();
  const order: string[] = [];
  const adj = new Map<string, string[]>();

  transitions.forEach((t) => {
    if (!adj.has(t.from)) adj.set(t.from, []);
    adj.get(t.from)!.push(t.to);
  });

  function dfs(node: string) {
    if (visited.has(node)) return;
    visited.add(node);
    (adj.get(node) ?? []).forEach(dfs);
    order.push(node);
  }

  // Start DFS from all nodes
  const allNodes = new Set<string>();
  transitions.forEach((t) => { allNodes.add(t.from); allNodes.add(t.to); });
  allNodes.forEach(dfs);
  order.reverse();

  const rank = new Map<string, number>();
  order.forEach((n, i) => rank.set(n, i));

  return (rank.get(to) ?? 0) < (rank.get(from) ?? 0);
}

function shortLabel(desc: string): string {
  if (!desc) return "";
  const words = desc.split(/\s+/);
  if (words.length <= 4) return desc;
  return words.slice(0, 4).join(" ") + "...";
}

function transitionsToEdges(transitions: Transition[]): Edge[] {
  return transitions.map((t, i) => {
    const loop = isLoopBack(t.from, t.to, transitions);
    return {
      id: `e-${t.from}-${t.to}-${i}`,
      source: t.from,
      target: t.to,
      label: shortLabel(t.description),
      type: "smoothstep",
      animated: loop,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: {
        stroke: loop ? "#d29922" : "#58a6ff",
        strokeDasharray: loop ? "6 3" : undefined,
      },
      labelStyle: { fill: loop ? "#d29922" : "#8b949e", fontSize: 11 },
      labelBgStyle: { fill: "#0d1117", fillOpacity: 0.9 },
      labelBgPadding: [6, 6] as [number, number],
      labelBgBorderRadius: 4,
      data: { fullDescription: t.description },
    };
  });
}

let stateIdCounter = 100;

export default function App() {
  const [workflow, setWorkflow] = useState(debugWorkflow);
  const [selectedStateId, setSelectedStateId] = useState<string | null>(null);
  const [view, setView] = useState<"editor" | "run">("editor");

  const initialEdges = useMemo(
    () => transitionsToEdges(workflow.transitions),
    []
  );
  const initialNodes = useMemo(() => {
    const raw = workflowToNodes(workflow.states);
    return layoutGraph(raw, initialEdges);
  }, []);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedStateId(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const onConnect: OnConnect = useCallback(
    (connection) => {
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            type: "smoothstep",
            markerEnd: { type: MarkerType.ArrowClosed },
            style: { stroke: "#58a6ff" },
            label: "describe...",
            labelStyle: { fill: "#8b949e", fontSize: 11 },
            labelBgStyle: { fill: "#0d1117", fillOpacity: 0.9 },
            labelBgPadding: [6, 6] as [number, number],
            labelBgBorderRadius: 4,
          },
          eds
        )
      );

      const newTransition: Transition = {
        from: connection.source!,
        to: connection.target!,
        description: "",
      };
      setWorkflow((w) => ({
        ...w,
        transitions: [...w.transitions, newTransition],
      }));
    },
    [setEdges]
  );

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedStateId(node.id);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedStateId(null);
  }, []);

  const selectedState = workflow.states.find((s) => s.id === selectedStateId);

  const allStateNames = workflow.states.map((s) => ({
    id: s.id,
    name: s.name,
  }));

  const onUpdateState = useCallback(
    (updated: WorkflowState) => {
      setWorkflow((w) => ({
        ...w,
        states: w.states.map((s) => (s.id === updated.id ? updated : s)),
      }));
      setNodes((nds) =>
        nds.map((n) =>
          n.id === updated.id
            ? { ...n, data: { ...n.data, state: updated } }
            : n
        )
      );
    },
    [setNodes]
  );

  const onUpdateTransitions = useCallback(
    (transitions: Transition[]) => {
      setWorkflow((w) => ({ ...w, transitions }));
      setEdges(transitionsToEdges(transitions));
    },
    [setEdges]
  );

  const deleteState = useCallback(() => {
    if (!selectedStateId) return;
    setWorkflow((w) => ({
      ...w,
      states: w.states.filter((s) => s.id !== selectedStateId),
      transitions: w.transitions.filter(
        (t) => t.from !== selectedStateId && t.to !== selectedStateId
      ),
    }));
    setNodes((nds) => nds.filter((n) => n.id !== selectedStateId));
    setEdges((eds) =>
      eds.filter(
        (e) => e.source !== selectedStateId && e.target !== selectedStateId
      )
    );
    setSelectedStateId(null);
  }, [selectedStateId, setNodes, setEdges]);

  const addState = useCallback(() => {
    const id = `state-${++stateIdCounter}`;
    const newState: WorkflowState = {
      id,
      name: "New State",
      actions: [],
    };
    setWorkflow((w) => ({ ...w, states: [...w.states, newState] }));
    setNodes((nds) => [
      ...nds,
      {
        id,
        type: "state",
        position: { x: 200, y: 200 },
        data: { state: newState } as StateNodeData,
      },
    ]);
    setSelectedStateId(id);
  }, [setNodes]);

  const exportWorkflow = useCallback(() => {
    const json = JSON.stringify(workflow, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${workflow.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [workflow]);

  const isEmpty = workflow.states.length === 0;

  return (
    <div className="app">
      <div className="top-bar">
        <div className="top-bar-left">
          <span className="app-logo">Agent Flow</span>
          <span className="workflow-name">{workflow.name}</span>
        </div>
        <div className="top-bar-center">
          <button
            className={`tab-btn ${view === "editor" ? "active" : ""}`}
            onClick={() => setView("editor")}
          >
            Editor
          </button>
          <button
            className={`tab-btn ${view === "run" ? "active" : ""}`}
            onClick={() => setView("run")}
          >
            Run
          </button>
        </div>
        <div className="top-bar-right">
          <button className="top-btn" onClick={addState}>
            + State
          </button>
          <button className="top-btn" onClick={exportWorkflow}>
            Export
          </button>
          <button className="top-btn primary">Run</button>
        </div>
      </div>

      <div className="main-area">
        {view === "editor" && (
          <>
            <div
              className={`canvas-container ${selectedState ? "with-panel" : ""}`}
            >
              {isEmpty && (
                <div className="empty-canvas">
                  <div className="empty-canvas-content">
                    <h2>Start building your workflow</h2>
                    <p>
                      Add states and connect them with transitions to create an
                      agent workflow.
                    </p>
                    <div className="empty-canvas-actions">
                      <button className="empty-btn primary" onClick={addState}>
                        + Add first state
                      </button>
                      <button
                        className="empty-btn"
                        onClick={() => {
                          /* TODO: templates */
                        }}
                      >
                        Start from template
                      </button>
                    </div>
                  </div>
                </div>
              )}
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onNodeClick={onNodeClick}
                onPaneClick={onPaneClick}
                nodeTypes={nodeTypes}
                fitView
                proOptions={{ hideAttribution: true }}
                defaultEdgeOptions={{
                  type: "smoothstep",
                }}
              >
                <Controls position="bottom-left" />
                <Background
                  variant={BackgroundVariant.Dots}
                  gap={20}
                  size={1}
                  color="#21262d"
                />
                <MiniMap
                  nodeColor="#1f6feb"
                  maskColor="rgba(0,0,0,0.7)"
                  style={{ background: "#0d1117" }}
                />
              </ReactFlow>
            </div>

            {selectedState && (
              <StatePanel
                state={selectedState}
                transitions={workflow.transitions}
                allStateNames={allStateNames}
                onUpdate={onUpdateState}
                onUpdateTransitions={onUpdateTransitions}
                onDelete={deleteState}
                onClose={() => setSelectedStateId(null)}
              />
            )}
          </>
        )}

        {view === "run" && (
          <div className="run-view">
            <div className="run-sessions">
              <div className="panel-label">Sessions</div>
              <div className="run-session-item active">
                <span className="session-dot running" />
                <div className="session-info">
                  <span className="session-name">Debug Issue</span>
                  <span className="session-time">2m ago</span>
                </div>
              </div>
              <div className="run-session-item">
                <span className="session-dot paused" />
                <div className="session-info">
                  <span className="session-name">Code Review</span>
                  <span className="session-time">15m ago</span>
                </div>
              </div>
              <div className="run-session-item">
                <span className="session-dot done" />
                <div className="session-info">
                  <span className="session-name">Fix Auth</span>
                  <span className="session-time">1h ago</span>
                </div>
              </div>
            </div>

            <div className="run-flow">
              <ReactFlow
                nodes={nodes.map((n, i) => ({
                  ...n,
                  data: {
                    ...n.data,
                    runStatus:
                      i < 3 ? "done" : i === 3 ? "active" : "pending",
                  },
                }))}
                edges={edges}
                nodeTypes={nodeTypes}
                fitView
                proOptions={{ hideAttribution: true }}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
              >
                <Background
                  variant={BackgroundVariant.Dots}
                  gap={20}
                  size={1}
                  color="#21262d"
                />
              </ReactFlow>
            </div>

            <div className="run-output">
              <div className="panel-label">Live Output</div>
              <div className="output-content">
                <div className="output-state">State: Review Investigation</div>
                <div className="output-line">
                  Claude is reviewing the root cause analysis...
                </div>
                <div className="output-line">
                  Reading file: src/auth/handler.ts
                </div>
                <div className="output-line">
                  Found potential null reference at line 42
                </div>
                <div className="output-line highlight">
                  The error occurs because session token is not validated
                </div>
                <div className="output-divider" />
                <div className="output-transition">
                  <span className="output-label">Transition Decision</span>
                  <div className="output-line">
                    Available: Implement Fix, Root Cause Tracing
                  </div>
                  <div className="output-line highlight">
                    Picked: Implement Fix — root cause is clear
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
