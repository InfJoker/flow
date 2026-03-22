import { useEffect, useRef } from "react";

interface LiveOutputProps {
  output: string[];
  currentState: string | null;
}

export default function LiveOutput({ output, currentState }: LiveOutputProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [output.length]);

  return (
    <div className="run-output">
      <div className="panel-label">Live Output</div>
      <div className="output-content">
        {currentState && (
          <div className="output-state">State: {currentState}</div>
        )}
        {output.map((line, i) => (
          <div
            key={i}
            className={`output-line ${
              line.startsWith("[Error]")
                ? "error"
                : line.startsWith("[Transition]") || line.startsWith("---")
                  ? "highlight"
                  : ""
            }`}
          >
            {line}
          </div>
        ))}
        {output.length === 0 && (
          <div className="output-line muted">Waiting for execution to start...</div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
