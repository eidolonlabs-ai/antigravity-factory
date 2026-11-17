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

function isFactoryInternalPath(relPath) {
  const norm = relPath.replace(/\\/g, "/");
  return (
    norm === ".factory" ||
    norm.startsWith(".factory/") ||
    norm.includes("/.factory/") ||
    norm.endsWith("/.factory")
  );
}

function hashUntrackedFile(absPath) {
  try {
    const stat = fs.lstatSync(absPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    const buf = fs.readFileSync(absPath);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

export function inspectGitStateFallback(cwd) {
  const realCwd = fs.existsSync(cwd) ? fs.realpathSync(cwd) : cwd;
  let gitRoot = "";
  try {
    const rawRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: realCwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!rawRoot || !fs.existsSync(rawRoot)) return null;
    gitRoot = fs.realpathSync(rawRoot);
  } catch {
    return null;
  }

  let rawPorcelain = "";
  try {
    rawPorcelain = execFileSync(
      "git",
      ["status", "--porcelain", "-z", "-uall", "--", "."],
      {
        cwd: realCwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
  } catch {
    return null;
  }

  const porcelainEntries = [];
  const dirtyPaths = [];
  const untrackedEntries = [];

  if (rawPorcelain) {
    const tokens = rawPorcelain.split("\0");
    for (let i = 0; i < tokens.length; i += 1) {
      const entry = tokens[i];
      if (!entry || entry.length < 4) continue;
      const xy = entry.slice(0, 2);
      const fileRelToRepo = entry.slice(3);
      let origRelToRepo = null;
      if (xy[0] === "R" || xy[0] === "C") {
        origRelToRepo = tokens[i + 1] || "";
        i += 1;
      }

      const absPath = path.resolve(gitRoot, fileRelToRepo);
      const relToCwd = path.relative(realCwd, absPath).split(path.sep).join("/");
      if (isFactoryInternalPath(fileRelToRepo) || isFactoryInternalPath(relToCwd)) {
        continue;
      }

      porcelainEntries.push(
        origRelToRepo !== null
          ? `${xy} ${origRelToRepo} -> ${fileRelToRepo}`
          : `${xy} ${fileRelToRepo}`
      );
      dirtyPaths.push(fileRelToRepo);

      if (xy === "??") {
        const contentHash = hashUntrackedFile(absPath);
        if (contentHash) {
          untrackedEntries.push(`${fileRelToRepo}:${contentHash}`);
        }
      }
    }
  }

  porcelainEntries.sort();
  untrackedEntries.sort();

  const excludeArgs = ["--", ".", ":(exclude).factory", ":(exclude)**/.factory/**"];
  let gitDiffHead = "";
  try {
    gitDiffHead = execFileSync(
      "git",
      ["diff", "HEAD", ...excludeArgs],
      {
        cwd: realCwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 10 * 1024 * 1024,
      }
    );
  } catch {
    const parts = [];
    try {
      const cached = execFileSync("git", ["diff", "--cached", ...excludeArgs], {
        cwd: realCwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 10 * 1024 * 1024,
      });
      if (cached) parts.push(cached);
    } catch {
      // Ignore cached diff failure
    }
    try {
      const worktree = execFileSync("git", ["diff", ...excludeArgs], {
        cwd: realCwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 10 * 1024 * 1024,
      });
      if (worktree) parts.push(worktree);
    } catch {
      // Ignore worktree diff failure
    }
    gitDiffHead = parts.join("\n");
  }

  const hasChanges =
    porcelainEntries.length > 0 || gitDiffHead.length > 0;

  const stateHash = crypto
    .createHash("sha256")
    .update(
      `${porcelainEntries.join("\n")}\n---\n${gitDiffHead}\n---\n${untrackedEntries.join("\n")}`
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

    if (payload.fullyIdle === false) {
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
      payload.conversationId || "default";
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
