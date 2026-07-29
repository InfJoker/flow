import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ActivityPanel from "./ActivityPanel";
import type { Attempt, ExecutionState } from "./engine/StateMachineEngine";
import type { SessionCapabilities } from "./hooks/useExecution";

const ALL: SessionCapabilities = { activity: true, chat: true, interrupt: true };
const NONE: SessionCapabilities = { activity: false, chat: false, interrupt: false };

function attempt(over: Partial<Attempt> = {}): Attempt {
  return {
    attemptId: over.attemptId ?? crypto.randomUUID(),
    kind: "state",
    stateId: "s1",
    label: "Implement",
    index: 1,
    status: "done",
    startedAt: "2026-07-28T10:00:00.000Z",
    completedAt: "2026-07-28T10:00:20.000Z",
    activity: [],
    ...over,
  };
}

function state(over: Partial<ExecutionState> = {}): ExecutionState {
  return {
    status: "running",
    currentStateId: "s1",
    history: [],
    attempts: [],
    output: [],
    ...over,
  };
}

function panel(props: Partial<Parameters<typeof ActivityPanel>[0]> = {}) {
  const merged = {
    executionState: state(),
    capabilities: ALL,
    canChat: true,
    filterStateName: null,
    filterStateId: null,
    onClearFilter: vi.fn(),
    onFilterState: vi.fn(),
    onSendChat: vi.fn(() => true),
    onInterrupt: vi.fn(),
    ...props,
  };
  return { ...render(<ActivityPanel {...merged} />), props: merged };
}

function card(label: string): HTMLDetailsElement {
  return screen.getByText(label).closest("details") as HTMLDetailsElement;
}

describe("attempt cards", () => {
  /**
   * The regression that mattered most. `open` is a live DOM property, so driving
   * it from `i === lastIndex` meant the card holding the just-finished state's
   * work slammed shut the instant the next state started — on the most frequent
   * event in the app.
   */
  it("leaves an open card open when a newer attempt arrives", () => {
    const first = attempt({ attemptId: "a1", label: "Implement" });
    const { rerender, props } = panel({
      executionState: state({ attempts: [first] }),
    });

    expect(card("Implement").open).toBe(true);

    rerender(
      <ActivityPanel
        {...props}
        executionState={state({
          attempts: [first, attempt({ attemptId: "a2", label: "Review", stateId: "s2" })],
        })}
      />
    );

    expect(card("Implement").open).toBe(true);
    expect(card("Review").open).toBe(true);
  });

  // Chat attempts land in the same array, so they trigger the same re-render.
  it("leaves an open card open when a chat message arrives", () => {
    const first = attempt({ attemptId: "a1", label: "Implement" });
    const { rerender, props } = panel({ executionState: state({ attempts: [first] }) });

    rerender(
      <ActivityPanel
        {...props}
        executionState={state({
          attempts: [
            first,
            attempt({
              attemptId: "c1",
              kind: "chat",
              stateId: null,
              label: "You",
              prompt: "focus on the parser",
              status: "running",
            }),
          ],
        })}
      />
    );

    expect(card("Implement").open).toBe(true);
  });

  // A failure used to be distinguishable only by the dot's colour, so finding
  // one in a long run meant opening every card.
  it("says a visit failed in the collapsed summary", () => {
    panel({
      executionState: state({
        attempts: [attempt({ status: "error", error: "boom", label: "Implement" })],
      }),
    });

    expect(screen.getByText(/failed/)).toBeTruthy();
  });

  it("labels repeat visits so a loop is visible without opening anything", () => {
    panel({
      executionState: state({
        attempts: [
          attempt({ attemptId: "a1", label: "Judge", index: 1 }),
          attempt({ attemptId: "a2", label: "Judge", index: 2 }),
          attempt({ attemptId: "a3", label: "Judge", index: 3 }),
        ],
      }),
    });

    expect(screen.getByText("run 2")).toBeTruthy();
    expect(screen.getByText("run 3")).toBeTruthy();
    // The first visit carries no badge — a linear workflow stays uncluttered.
    expect(screen.queryByText("run 1")).toBeNull();
  });

  it("shows the transition a visit chose, which is why a loop went round", () => {
    panel({
      executionState: state({
        attempts: [
          attempt({
            label: "Judge",
            transition: { picked: "Implement", reason: "score below 4" },
          }),
        ],
      }),
    });

    expect(screen.getByText(/Implement/)).toBeTruthy();
    expect(screen.getByText("score below 4")).toBeTruthy();
  });
});

describe("chat composer", () => {
  /**
   * The data-loss bug: a session can advertise chat while the app is only
   * observing it, and the send then had nothing to travel through. The box was
   * cleared regardless, so the user's text simply vanished.
   */
  it("keeps the draft when the send could not be dispatched", async () => {
    const user = userEvent.setup();
    const onSendChat = vi.fn(() => false);
    panel({ onSendChat });

    const box = screen.getByLabelText("Message the agent");
    await user.type(box, "do not lose this");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(onSendChat).toHaveBeenCalledWith("do not lose this");
    expect((box as HTMLTextAreaElement).value).toBe("do not lose this");
  });

  it("clears the draft once the message is on its way", async () => {
    const user = userEvent.setup();
    panel({ onSendChat: vi.fn(() => true) });

    const box = screen.getByLabelText("Message the agent");
    await user.type(box, "steer left");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect((box as HTMLTextAreaElement).value).toBe("");
  });

  it("disables the composer while merely observing a session", () => {
    panel({ canChat: false });

    const box = screen.getByLabelText("Message the agent") as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect(box.placeholder).toMatch(/watching/i);
  });

  // The channel backend owns no session to message into, so saying so beats
  // rendering a box that looks usable.
  it("explains itself on a backend that cannot accept messages", () => {
    panel({ capabilities: NONE, canChat: false });

    const box = screen.getByLabelText("Message the agent") as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect(box.placeholder).toMatch(/does not accept messages/i);
  });

  it("does not send an empty message", async () => {
    const user = userEvent.setup();
    const onSendChat = vi.fn(() => true);
    panel({ onSendChat });

    await user.type(screen.getByLabelText("Message the agent"), "   ");
    // The button stays disabled, so Enter is the only way to try.
    await user.keyboard("{Enter}");

    expect(onSendChat).not.toHaveBeenCalled();
  });

  it("sends on Enter but takes a newline on Shift+Enter", async () => {
    const user = userEvent.setup();
    const onSendChat = vi.fn(() => true);
    panel({ onSendChat });

    const box = screen.getByLabelText("Message the agent");
    await user.type(box, "first{Shift>}{Enter}{/Shift}second");
    expect(onSendChat).not.toHaveBeenCalled();

    await user.keyboard("{Enter}");
    expect(onSendChat).toHaveBeenCalledWith("first\nsecond");
  });
});

describe("run state", () => {
  it("states the outcome when a run fails, rather than looking still-busy", () => {
    panel({ executionState: state({ status: "error", error: "channel closed" }) });

    expect(screen.getByRole("status").textContent).toMatch(/failed/i);
    expect(screen.getByText(/channel closed/)).toBeTruthy();
  });

  it("states the outcome when a run finishes", () => {
    panel({ executionState: state({ status: "completed" }) });

    expect(screen.getByRole("status").textContent).toMatch(/finished/i);
  });

  it("offers Interrupt only while running, and only where it is supported", () => {
    const { unmount } = panel({ executionState: state({ status: "running" }) });
    expect(screen.queryByRole("button", { name: /interrupt/i })).toBeTruthy();
    unmount();

    panel({ executionState: state({ status: "running" }), capabilities: NONE });
    expect(screen.queryByRole("button", { name: /interrupt/i })).toBeNull();
  });

  // A state the run has not reached yet has no attempt to borrow a name from;
  // showing its raw id over a blank panel read as a bug.
  it("names a filtered state that has not run yet, and says so", () => {
    panel({ filterStateId: "s9", filterStateName: "Deploy" });

    expect(screen.getByText("Deploy")).toBeTruthy();
    expect(screen.getByText(/has not run yet/)).toBeTruthy();
  });

  it("warns when a session reports results only", () => {
    panel({
      capabilities: { activity: false, chat: false, interrupt: false },
      executionState: state({ attempts: [attempt()] }),
    });

    expect(screen.getByText(/step-by-step activity/i)).toBeTruthy();
  });
});
