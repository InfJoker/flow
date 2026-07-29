import { describe, it, expect } from "vitest";
import { pickSession, sessionsForProject, type SessionInfo } from "./SessionManager";

function session(id: string, startedAt: string, cwd?: string): SessionInfo {
  return {
    sessionId: id,
    port: 1234,
    workflowId: "wf",
    workflowName: "WF",
    pid: 1,
    startedAt,
    ...(cwd ? { cwd } : {}),
  };
}

// discover_sessions returns read_dir order, so the array order carries no
// meaning — these fixtures deliberately list the newest session last.
const stale = session("stale", "2026-05-06T08:24:16.828Z");
const older = session("older", "2026-06-18T12:47:18.131Z");
const newest = session("newest", "2026-07-26T02:27:55.625Z");

describe("pickSession", () => {
  it("returns the user's selected session when it is still alive", () => {
    expect(pickSession([stale, older, newest], "older")).toBe(older);
  });

  it("falls back to the newest session when nothing is selected", () => {
    expect(pickSession([stale, older, newest], null)).toBe(newest);
  });

  // The selected session disappears whenever its Claude Code process exits and
  // discover_sessions prunes the file; the run should go to the newest live one
  // rather than whatever the filesystem happened to list first.
  it("falls back to the newest when the selection is gone", () => {
    expect(pickSession([stale, older, newest], "vanished")).toBe(newest);
  });

  it("does not simply take the first entry", () => {
    expect(pickSession([stale, older, newest], null)).not.toBe(stale);
  });

  it("does not mutate the caller's array", () => {
    const sessions = [stale, older, newest];
    pickSession(sessions, null);
    expect(sessions).toEqual([stale, older, newest]);
  });

  it("returns undefined when there are no sessions", () => {
    expect(pickSession([], null)).toBeUndefined();
  });

  it("still returns a session when timestamps are unparseable", () => {
    const bad = session("bad", "not-a-date");
    expect(pickSession([bad], null)).toBe(bad);
  });
});

describe("scoping sessions to the open project", () => {
  const repo = "/Users/george/agent-flow";
  const scratch = "/private/tmp/scratchpad";

  const inRepo = session("in-repo", "2026-07-26T01:00:00.000Z", repo);
  const inScratch = session("in-scratch", "2026-07-26T02:00:00.000Z", scratch);
  const unknownCwd = session("legacy", "2026-07-26T03:00:00.000Z");

  it("keeps only sessions whose working directory is the project", () => {
    expect(sessionsForProject([inRepo, inScratch], repo)).toEqual([inRepo]);
  });

  // A session written before `cwd` existed cannot be shown to the user as a
  // consent surface, so it is excluded rather than assumed to match.
  it("excludes sessions with no recorded working directory", () => {
    expect(sessionsForProject([unknownCwd], repo)).toEqual([]);
  });

  /**
   * The safety case. The newest session on this machine was a scratchpad one,
   * so an unfiltered fallback would hand an edit-capable Claude a folder the
   * user never chose — while the launch UI named the repo.
   */
  it("never falls back to a session belonging to another folder", () => {
    expect(pickSession([inRepo, inScratch], null, repo)).toBe(inRepo);
  });

  it("refuses a selected session that belongs to another folder", () => {
    expect(pickSession([inRepo, inScratch], "in-scratch", repo)).toBe(inRepo);
  });

  it("returns nothing rather than guessing when the project has no session", () => {
    expect(pickSession([inScratch], null, repo)).toBeUndefined();
  });
});
