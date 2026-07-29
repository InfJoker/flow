import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Unmount between tests. Without this, a component from an earlier test is still
// in the document and queries like getByRole find two matches.
afterEach(() => {
  cleanup();
});

// jsdom implements neither, and both are used by the run view: ActivityPanel
// pins the transcript to the bottom on each flush, and the engine coalesces
// activity repaints onto a frame.
if (!window.requestAnimationFrame) {
  window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof window.cancelAnimationFrame;
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
