import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { SessionInfo } from "./types.js";

const SESSIONS_DIR = join(homedir(), ".agent-flow", "sessions");

let sessionFilePath: string | null = null;

export function writeSessionFile(
  port: number,
  workflowId: string,
  workflowName: string
): SessionInfo {
  mkdirSync(SESSIONS_DIR, { recursive: true });

  const info: SessionInfo = {
    sessionId: randomUUID(),
    port,
    workflowId,
    workflowName,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };

  sessionFilePath = join(SESSIONS_DIR, `${info.sessionId}.json`);
  writeFileSync(sessionFilePath, JSON.stringify(info, null, 2));

  return info;
}

export function updateSessionFile(info: SessionInfo): void {
  if (sessionFilePath) {
    writeFileSync(sessionFilePath, JSON.stringify(info, null, 2));
  }
}

export function cleanupSessionFile(): void {
  if (sessionFilePath && existsSync(sessionFilePath)) {
    try {
      unlinkSync(sessionFilePath);
    } catch {
      // ignore cleanup errors
    }
  }
}
