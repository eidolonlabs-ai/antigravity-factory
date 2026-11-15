#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONTINUE_REASON =
  "Unverified code changes detected. Run `agy-factory verify` (or `node bin/agy-factory.js verify`) and ensure checks pass before finishing.";

const MAX_RECORDED_KEYS = 200;

let sharedVerify = null;
try {
  sharedVerify = await import("../lib/verify.js");
} catch {
  sharedVerify = null;
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function isEnforcementEnabled(cwd, env) {
  if (env?.FACTORY_ENFORCE_STOP === "1") {
    return true;
  }
  const config = readJsonFile(path.join(cwd, ".factory.json"));
  return config?.enforceStopVerify === true;
}

function extractPorcelainPath(line) {
  const raw = line.slice(3);
  const target = raw.includes(" -> ") ? raw.split(" -> ").pop() : raw;
  const unquoted =
    target.startsWith('"') && target.endsWith('"')
      ? target.slice(1, -1)
      : target;
  return unquoted.replace(/\\/g, "/");
}

function isFactoryInternalPath(relPath) {
  return (
    relPath === ".factory" ||
    relPath.startsWith(".factory/") ||
    relPath.includes("/.factory/")
  );
}

function hashUntrackedFile(absPath) {
  try {
    const stat = fs.lstatSync(absPath);
    if (!stat.isFile()) return null;
    const buf = fs.readFileSync(absPath);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

function inspectGitStateFallback(cwd) {
  let gitRoot = "";
  try {
    gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }

  let rawPorcelain = "";
  try {
    rawPorcelain = execFileSync(
      "git",
      ["status", "--porcelain", "-uall", "--", "."],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
  } catch {
    return null;
  }

  const dirtyLines = [];
  const dirtyPaths = [];
  const untrackedEntries = [];

  for (const line of rawPorcelain.split(/\r?\n/)) {
    if (!line) continue;
    const relPath = extractPorcelainPath(line);
    if (isFactoryInternalPath(relPath)) continue;
    dirtyLines.push(line);
    dirtyPaths.push(relPath);

    if (line.startsWith("?? ")) {
      const absUntracked = path.resolve(gitRoot, relPath);
      const contentHash = hashUntrackedFile(absUntracked);
      if (contentHash) {
        untrackedEntries.push(`${relPath}:${contentHash}`);
      }
    }
  }

  untrackedEntries.sort();

  let gitDiffHead = "";
  try {
    gitDiffHead = execFileSync(
      "git",
      ["diff", "HEAD", "--", ".", ":(exclude).factory"],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 10 * 1024 * 1024,
      }
    );
  } catch {
    gitDiffHead = "";
  }

  const filteredPorcelain = dirtyLines.join("\n");
  const hasChanges =
    filteredPorcelain.length > 0 || gitDiffHead.trim().length > 0;

  const stateHash = crypto
    .createHash("sha256")
    .update(
      `${filteredPorcelain}\n${gitDiffHead}\n${untrackedEntries.join("\n")}`
    )
    .digest("hex");

  return {
    gitRoot,
    hasChanges,
    stateHash,
    dirtyPaths,
  };
}

function inspectGitState(cwd) {
  if (
    typeof sharedVerify?.hasUncommittedChanges === "function" &&
    typeof sharedVerify?.computeWorkspaceDigest === "function"
  ) {
    try {
      const hasChanges = Boolean(sharedVerify.hasUncommittedChanges(cwd));
      if (!hasChanges) {
        return {
          gitRoot: null,
          hasChanges: false,
          stateHash: "",
          dirtyPaths: null,
        };
      }
      const stateHash = sharedVerify.computeWorkspaceDigest(cwd);
      if (typeof stateHash === "string" && stateHash.length > 0) {
        return {
          gitRoot: null,
          hasChanges: true,
          stateHash,
          dirtyPaths: null,
        };
      }
    } catch {
      // Fall through to self-contained git inspection fallback.
    }
  }

  return inspectGitStateFallback(cwd);
}

function isReceiptFreshAndPassing(cwd, gitState) {
  const receiptPath = path.join(cwd, ".factory", "verify-receipt.json");
  const receipt = readJsonFile(receiptPath);
  if (!receipt || receipt.ok !== true) {
    return false;
  }

  if (typeof receipt.digest === "string" && receipt.digest.length > 0) {
    return receipt.digest === gitState.stateHash;
  }

  const resolvedState =
    Array.isArray(gitState.dirtyPaths) && gitState.gitRoot
      ? gitState
      : inspectGitStateFallback(cwd);
  if (!resolvedState) {
    return false;
  }

  const parsedTimestamp = Date.parse(receipt.timestamp ?? "");
  let receiptStatMs = 0;
  try {
    receiptStatMs = Math.floor(fs.statSync(receiptPath).mtimeMs);
  } catch {
    receiptStatMs = 0;
  }

  const receiptTimeMs = Math.max(
    Number.isFinite(parsedTimestamp) ? parsedTimestamp : 0,
    receiptStatMs
  );

  if (receiptTimeMs <= 0) {
    return false;
  }

  const baseDir = resolvedState.gitRoot || cwd;
  for (const relPath of resolvedState.dirtyPaths) {
    const absPath = path.resolve(baseDir, relPath);
    try {
      if (!fs.existsSync(absPath)) {
        return false;
      }
      const stat = fs.lstatSync(absPath);
      if (Math.floor(stat.mtimeMs) > receiptTimeMs) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
}

function hasAlreadyPromptedAndRecord(cwd, promptKey) {
  const factoryDir = path.join(cwd, ".factory");
  const statePath = path.join(factoryDir, "stop-gate-state.json");
  const existing = readJsonFile(statePath);
  const promptedKeys =
    existing &&
    typeof existing.promptedKeys === "object" &&
    existing.promptedKeys !== null
      ? { ...existing.promptedKeys }
      : {};

  if (promptedKeys[promptKey]) {
    return true;
  }

  promptedKeys[promptKey] = new Date().toISOString();
  const keys = Object.keys(promptedKeys);
  if (keys.length > MAX_RECORDED_KEYS) {
    for (const oldKey of keys.slice(0, keys.length - MAX_RECORDED_KEYS)) {
      delete promptedKeys[oldKey];
    }
  }

  try {
    fs.mkdirSync(factoryDir, { recursive: true });
    fs.writeFileSync(
      statePath,
      `${JSON.stringify({ promptedKeys }, null, 2)}\n`,
      "utf8"
    );
  } catch {
    // If the workspace is read-only, fail safe rather than risking an infinite loop.
    return true;
  }

  return false;
}

export function evaluateStop(payload, { env = process.env } = {}) {
  try {
    if (
      !payload ||
      typeof payload !== "object" ||
      Object.keys(payload).length === 0
    ) {
      return { decision: "allow" };
    }

    if (payload.fullyIdle === false || payload.stop_hook_active === true) {
      return { decision: "allow" };
    }

    if (typeof payload.executionNum === "number" && payload.executionNum >= 3) {
      return { decision: "allow" };
    }

    if (
      payload.terminationReason !== undefined &&
      payload.terminationReason !== "NO_TOOL_CALL"
    ) {
      return { decision: "allow" };
    }

    const rawCwd =
      Array.isArray(payload.workspacePaths) && payload.workspacePaths[0]
        ? payload.workspacePaths[0]
        : payload.workspaceRoot || payload.cwd || process.cwd();
    const cwd = path.resolve(rawCwd);

    if (!isEnforcementEnabled(cwd, env)) {
      return { decision: "allow" };
    }

    const gitState = inspectGitState(cwd);
    if (!gitState || !gitState.hasChanges) {
      return { decision: "allow" };
    }

    if (isReceiptFreshAndPassing(cwd, gitState)) {
      return { decision: "allow" };
    }

    const sessionKey =
      payload.conversationId || payload.session_id || payload.sessionId || "default";
    const promptKey = `${sessionKey}:${gitState.stateHash}`;
    if (hasAlreadyPromptedAndRecord(cwd, promptKey)) {
      return { decision: "allow" };
    }

    return {
      decision: "continue",
      reason: CONTINUE_REASON,
    };
  } catch {
    return { decision: "allow" };
  }
}

export function formatStopWireOutput(result, payload) {
  const safeResult =
    result && typeof result === "object" ? result : { decision: "allow" };
  if (!payload || typeof payload !== "object") {
    return safeResult;
  }

  if (payload.hook_event_name === "AfterAgent") {
    if (safeResult.decision === "continue") {
      return { decision: "block", reason: safeResult.reason };
    }
    return { decision: "allow" };
  }

  const isClaudeCode =
    payload.hook_event_name === "Stop" ||
    (payload.stop_hook_active !== undefined &&
      payload.terminationReason === undefined);

  if (isClaudeCode) {
    if (safeResult.decision === "continue") {
      return { decision: "block", reason: safeResult.reason };
    }
    return {};
  }

  return safeResult;
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
