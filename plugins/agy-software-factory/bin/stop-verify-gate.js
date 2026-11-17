#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadFactoryPolicy } from "../lib/policy.js";
import { evaluateStatus } from "../lib/status.js";
import { readRecord, writeRecord } from "../lib/records.js";
import { snapshotWorkspace } from "../lib/workspace.js";

const CONTINUE_REASON =
  "Unverified code changes detected. Run `agy-factory verify` (or `node bin/agy-factory.js verify`) and ensure checks pass before finishing.";

const MAX_RECORDED_KEYS = 200;

// Compatibility export; all consumers now share the same fail-closed snapshot logic.
export function inspectGitStateFallback(cwd) {
  try {
    const state = snapshotWorkspace(cwd);
    return { hasChanges: state.hasChanges, stateHash: state.digest };
  } catch {
    return null;
  }
}

export function evaluateStop(payload, { env = process.env } = {}) {
  try {
    if (
      !payload ||
      typeof payload !== "object" ||
      !Object.keys(payload).length ||
      payload.fullyIdle === false
    )
      return { decision: "allow" };
    if (
      payload.terminationReason !== undefined &&
      !["model_stop", "NO_TOOL_CALL"].includes(payload.terminationReason)
    )
      return { decision: "allow" };
    const cwd = path.resolve(
      payload.workspacePaths?.[0] ||
        payload.workspaceRoot ||
        payload.cwd ||
        process.cwd(),
    );
    const policy = loadFactoryPolicy(cwd);
    if (policy.stop.mode === "off" && env.FACTORY_ENFORCE_STOP !== "1")
      return { decision: "allow" };
    const conversationId = String(payload.conversationId || "default");
    const result = evaluateStatus({ cwd, conversationId });
    const stored = readRecord(cwd, "stop-gate-state.json");
    const sessions = Object.assign(Object.create(null), stored?.sessions || {});
    if (result.outcome === "VERIFIED") {
      if (Object.hasOwn(sessions, conversationId)) {
        delete sessions[conversationId];
        writeRecord(cwd, "stop-gate-state.json", {
          schemaVersion: 1,
          sessions,
        });
      }
      return { decision: "allow" };
    }
    const prior = Object.hasOwn(sessions, conversationId)
      ? sessions[conversationId]
      : null;
    const count =
      Number.isInteger(prior?.count) && prior.count >= 0 ? prior.count : 0;
    const exhausted = count >= policy.stop.maxContinuations;
    sessions[conversationId] = {
      count: exhausted ? count : count + 1,
      exhausted,
      updatedAt: new Date().toISOString(),
    };
    const keys = Object.keys(sessions).sort((a, b) =>
      sessions[a].updatedAt.localeCompare(sessions[b].updatedAt),
    );
    for (const key of keys.slice(
      0,
      Math.max(0, keys.length - MAX_RECORDED_KEYS),
    ))
      delete sessions[key];
    writeRecord(cwd, "stop-gate-state.json", { schemaVersion: 1, sessions });
    return exhausted
      ? { decision: "allow" }
      : {
          decision: "continue",
          reason:
            CONTINUE_REASON +
            " Check `agy-factory status --json`; report incomplete work if the reminder budget is exhausted.",
        };
  } catch {
    // Native command-hook errors cannot enforce a hard barrier. Never write passing evidence.
    return { decision: "allow" };
  }
}

export function formatStopWireOutput(result) {
  return result && typeof result === "object" ? result : { decision: "allow" };
}

async function readStdin() {
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isMainModule() {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(modulePath);
  } catch {
    return path.resolve(process.argv[1]) === modulePath;
  }
}

if (isMainModule()) {
  readStdin()
    .then((raw) => {
      const trimmed = raw.trim();
      if (!trimmed) {
        process.stdout.write(`${JSON.stringify({ decision: "allow" })}\n`);
        return;
      }
      const payload = JSON.parse(trimmed);
      const result = evaluateStop(payload);
      const wireOutput = formatStopWireOutput(result, payload);
      process.stdout.write(`${JSON.stringify(wireOutput)}\n`);
    })
    .catch(() => {
      process.stdout.write(`${JSON.stringify({ decision: "allow" })}\n`);
    });
}
