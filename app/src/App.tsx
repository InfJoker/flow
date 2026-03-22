import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Controls,
  Background,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type OnConnect,
  type Node,
  type Edge,
  BackgroundVariant,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./App.css";

import StatePanel from "./StatePanel";
import RunView from "./RunView";
import { debugWorkflow } from "./mockData"; // used as example template
import { nodeTypes, workflowToNodes, transitionsToEdges } from "./graphUtils";
import { useSkills } from "./hooks/useSkills";
import { useAgents } from "./hooks/useAgents";
import { useWorkflowPersistence } from "./hooks/useWorkflowPersistence";
import { useExecution } from "./hooks/useExecution";
import type { Workflow, WorkflowState, Transition, StateNodeData } from "./types";

function newStateId(): string {
  return `state-${crypto.randomUUID().slice(0, 8)}`;
}

export default function App() {
  return (
    <ReactFlowProvider>
      <AppInner />
    </ReactFlowProvider>
  );
}

function AppInner() {
  const { fitView } = useReactFlow();
  const [workflow, setWorkflow] = useState<Workflow>({
    id: `workflow-${Date.now()}`,
    name: "New Workflow",
    description: "",
    states: [],
    transitions: [],
  });
  const [selectedStateId, setSelectedStateId] = useState<string | null>(null);
  const [view, setView] = useState<"editor" | "run">("editor");
  const [showLibrary, setShowLibrary] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const initialEdges = useMemo(
    () => transitionsToEdges(workflow.transitions),
    []
  );
  const initialNodes = useMemo(() => {
    return workflowToNodes(workflow.states, initialEdges);
  }, []);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const { skills: allSkills } = useSkills();
  const skillsOnly = allSkills.filter((s) => !s.path.includes("/agents/"));
  const { agents } = useAgents(allSkills);
  const {
    executionState,
    sessions,
    activeSessionId,
    refreshSessions,
    startExecution,
    connectToSession,
    pause,
    resume,
    stop,
  } = useExecution();
  const { workflowList, load, save, remove, isTauri } = useWorkflowPersistence(
    workflow,
    useCallback((loaded: Workflow) => {
      const loadedEdges = transitionsToEdges(loaded.transitions);
      setWorkflow(loaded);
      setNodes(workflowToNodes(loaded.states, loadedEdges));
      setEdges(loadedEdges);
      setSelectedStateId(null);
      setTimeout(() => fitView({ padding: 0.2 }), 50);
    }, [setNodes, setEdges, fitView])
  );

  // Sync node positions back to workflow after drag
  const onNodeDragStop = useCallback((_: React.MouseEvent, _node: Node, nodes: Node[]) => {
    setWorkflow((w) => ({
      ...w,
      states: w.states.map((s) => {
        const node = nodes.find((n) => n.id === s.id);
        if (node) {
          return { ...s, position: { x: node.position.x, y: node.position.y } };
        }
        return s;
      }),
    }));
  }, []);

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
    const id = newStateId();
    const pos = { x: 200, y: 200 };
    const newState: WorkflowState = {
      id,
      name: "New State",
      actions: [],
      position: pos,
    };
    setWorkflow((w) => ({ ...w, states: [...w.states, newState] }));
    setNodes((nds) => [
      ...nds,
      {
        id,
        type: "state",
        position: pos,
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
          <div className="workflow-name-container">
            {editingName ? (
              <input
                className="workflow-name-input"
                value={workflow.name}
                onChange={(e) => setWorkflow((w) => ({ ...w, name: e.target.value }))}
                onBlur={() => setEditingName(false)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === "Escape") setEditingName(false);
                }}
                autoFocus
              />
            ) : (
              <span className="workflow-name-group">
                <button
                  className="workflow-name"
                  onClick={() => isTauri && setShowLibrary(!showLibrary)}
                >
                  {workflow.name} {isTauri && <span className="dropdown-arrow">&#9662;</span>}
                </button>
                <button
                  className="workflow-name-edit"
                  onClick={() => setEditingName(true)}
                  title="Rename workflow"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M8.5 1.5L10.5 3.5M1 11L1.5 8.5L9 1L11 3L3.5 10.5L1 11Z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
              </span>
            )}
            {showLibrary && (
              <div className="workflow-library">
                {workflowList.map((w) => (
                  <div
                    key={w.id}
                    className={`workflow-library-item ${w.id === workflow.id ? "active" : ""}`}
                  >
                    <button
                      className="wl-load"
                      onClick={() => {
                        load(w.id);
                        setShowLibrary(false);
                      }}
                    >
                      <span className="wl-name">{w.name}</span>
                      <span className="wl-desc">{w.description || "No description"}</span>
                    </button>
                    {confirmDeleteId === w.id ? (
                      <div className="wl-confirm">
                        <button
                          className="wl-confirm-yes"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (w.id === workflow.id) {
                              setWorkflow({
                                id: `workflow-${Date.now()}`,
                                name: "New Workflow",
                                description: "",
                                states: [],
                                transitions: [],
                              });
                              setNodes([]);
                              setEdges([]);
                            }
                            remove(w.id);
                            setConfirmDeleteId(null);
                          }}
                        >
                          Delete
                        </button>
                        <button
                          className="wl-confirm-no"
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDeleteId(null);
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        className="wl-delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDeleteId(w.id);
                        }}
                        title="Delete workflow"
                      >
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                          <path d="M2 2L10 10M10 2L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                        </svg>
                      </button>
                    )}
                  </div>
                ))}
                <div className="workflow-library-divider" />
                <button
                  className="wl-new"
                  onClick={() => {
                    const id = `workflow-${Date.now()}`;
                    setWorkflow({
                      id,
                      name: "New Workflow",
                      description: "",
                      states: [],
                      transitions: [],
                    });
                    setNodes([]);
                    setEdges([]);
                    setSelectedStateId(null);
                    setShowLibrary(false);
                  }}
                >
                  + New Workflow
                </button>
              </div>
            )}
          </div>
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
          {isTauri && (
            <button className="top-btn" onClick={save}>
              Save
            </button>
          )}
          <button className="top-btn" onClick={exportWorkflow}>
            Export
          </button>
          {executionState.status === "running" ? (
            <>
              <button className="top-btn" onClick={pause}>Pause</button>
              <button className="top-btn danger" onClick={stop}>Stop</button>
            </>
          ) : (
            <button
              className="top-btn primary"
              onClick={() => {
                setView("run");
                startExecution(workflow);
              }}
            >
              Run
            </button>
          )}
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
                          const template = { ...debugWorkflow, id: `workflow-${Date.now()}` };
                          const templateEdges = transitionsToEdges(template.transitions);
                          setWorkflow(template);
                          setNodes(workflowToNodes(template.states, templateEdges));
                          setEdges(templateEdges);
                          setTimeout(() => fitView({ padding: 0.2 }), 50);
                        }}
                      >
                        Debug workflow template
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
                onNodeDragStop={onNodeDragStop}
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
                skills={skillsOnly}
                agents={agents}
                onUpdate={onUpdateState}
                onUpdateTransitions={onUpdateTransitions}
                onDelete={deleteState}
                onClose={() => setSelectedStateId(null)}
              />
            )}
          </>
        )}

        {view === "run" && (
          <RunView
            nodes={nodes}
            edges={edges}
            executionState={executionState}
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelectSession={(session) => connectToSession(session, workflow)}
            onRefreshSessions={refreshSessions}
          />
        )}
      </div>
    </div>
  );
}
