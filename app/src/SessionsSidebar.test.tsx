import { describe, it, expect } from "vitest";
import { shortenPath } from "./SessionsSidebar";

describe("shortenPath", () => {
  it("keeps the last two segments, which identify the project", () => {
    expect(shortenPath("/Users/george/code/agent-flow")).toBe("…/code/agent-flow");
  });

  it("leaves short paths alone", () => {
    expect(shortenPath("/tmp")).toBe("/tmp");
    expect(shortenPath("/Users/george")).toBe("/Users/george");
  });

  it("ignores a trailing slash rather than emitting an empty segment", () => {
    expect(shortenPath("/Users/george/code/agent-flow/")).toBe("…/code/agent-flow");
  });

  it("handles a relative path", () => {
    expect(shortenPath("a/b/c/d")).toBe("…/c/d");
  });
});
