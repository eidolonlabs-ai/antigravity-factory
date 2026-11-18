#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  decideContractCase,
  evaluateShellCommand,
  inspectTargetPath,
} from "../lib/guard.js";
import {
  matchesAllowedPath,
  normalizeAllowPathsList,
} from "../lib/spec.js";

export { decideContractCase };

function isWithinDir(rootDir, targetPath) {
  const rel = path.relative(rootDir, targetPath);
  return (
    rel === "" ||
    (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`))
  );
}

function collectWorkspaceRoots(payload) {
  const raw = [];
  if (Array.isArray(payload.workspacePaths)) {
    for (const p of payload.workspacePaths) {
      if (typeof p === "string" && p.trim()) raw.push(path.resolve(p));
    }
  }
  if (raw.length === 0) {
    const fallback = payload.workspaceRoot || payload.cwd || process.cwd();
    raw.push(path.resolve(String(fallback)));
  }
  return [...new Set(raw)];
}

function pickWorkspaceRoot(roots, targetPath, baseCwd) {
  if (roots.length === 1 || !targetPath) return roots[0];
  const candidate = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(baseCwd || roots[0], targetPath);
  for (const root of roots) {
    if (isWithinDir(root, candidate)) return root;
    try {
      const realRoot = fs.realpathSync(root);
      if (isWithinDir(realRoot, candidate)) return root;
    } catch {
      // Ignore nonexistent virtual test roots
    }
  }
  return roots[0];
}

function readJsonFileStrict(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, data: null };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    return {
      exists: true,
      error: `Invalid JSON in ${path.basename(filePath)}: ${err.message}`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      exists: true,
      error: `Invalid object structure in ${path.basename(filePath)}.`,
    };
  }
  return { exists: true, data: parsed };
}

function loadGuardPolicyForRoot(workspaceRoot, activeSlice) {
  const resolvedRoot = path.resolve(workspaceRoot || process.cwd());
  const frozen = [];

  const planPath = path.join(resolvedRoot, ".factory", "plan.json");
  const planRes = readJsonFileStrict(planPath);
  if (planRes.error) {
    return { error: planRes.error };
  }
  if (planRes.data) {
    if (Array.isArray(planRes.data.frozen)) {
      for (const f of planRes.data.frozen) {
        if (typeof f === "string" && f.trim()) frozen.push(f.trim());
      }
    }
    if (Array.isArray(planRes.data.holdout)) {
      for (const h of planRes.data.holdout) {
        if (typeof h === "string" && h.trim()) frozen.push(h.trim());
      }
    }
  }

  let specPath = path.join(resolvedRoot, ".factory", "spec.json");
  if (!fs.existsSync(specPath)) {
    specPath = path.join(resolvedRoot, "factory-spec.json");
  }
  const specRes = readJsonFileStrict(specPath);
  if (specRes.error) {
    return { error: specRes.error };
  }

  let allowList = null;
  if (specRes.data) {
    if (Array.isArray(specRes.data.frozen)) {
      for (const f of specRes.data.frozen) {
        if (typeof f === "string" && f.trim()) frozen.push(f.trim());
      }
    }
    if (activeSlice && Array.isArray(specRes.data.sharedPaths)) {
      for (const s of specRes.data.sharedPaths) {
        if (typeof s === "string" && s.trim()) frozen.push(s.trim());
      }
    }
    if (activeSlice) {
      const sliceDef = specRes.data.slices?.[activeSlice];
      if (!sliceDef || typeof sliceDef !== "object") {
        return {
          error: `Unknown slice "${activeSlice}" in ${path.basename(specPath)}.`,
        };
      }
      const normalized = normalizeAllowPathsList(sliceDef.allowPaths);
      if (normalized.length === 0) {
        return {
          error: `Active slice "${activeSlice}" has empty allowPaths in ${path.basename(specPath)}.`,
        };
      }
      allowList = normalized;
    }
  } else if (activeSlice) {
    return {
      error: `FACTORY_SLICE="${activeSlice}" is set but no factory spec exists in ${resolvedRoot}.`,
    };
  }

  return {
    ctx: frozen.length > 0 ? { frozen } : {},
    allowList,
  };
}

function checkSliceBoundary(relOrRaw, activeSlice, allowList) {
  if (!activeSlice || !allowList) return { decision: "allow" };
  const rel = String(relOrRaw || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  const normalizedRel = rel === "." ? "" : rel;
  if (!matchesAllowedPath(normalizedRel, allowList)) {
    return {
      decision: "deny",
      reason: `Blocked out-of-slice edit to "${normalizedRel}" for active slice "${activeSlice}" (allowed: ${allowList.join(", ")}).`,
    };
  }
  return { decision: "allow" };
}

export function evaluatePreToolUse(payload, { env = process.env } = {}) {
  try {
    if (!payload || typeof payload !== "object") {
      return { decision: "allow" };
    }

    const toolCall =
      payload.toolCall && typeof payload.toolCall === "object"
        ? payload.toolCall
        : null;
    const toolName = String(toolCall?.name ?? "");
    const args =
      (toolCall?.args && typeof toolCall.args === "object"
        ? toolCall.args
        : null) || {};

    const activeSlice = env?.FACTORY_SLICE || payload.slice || null;
    const workspaceRoots = collectWorkspaceRoots(payload);
    const primaryRoot = workspaceRoots[0];
    const effectiveCwd = path.resolve(payload.cwd || primaryRoot);

    const isFileWriteTool = toolName === "write_file" || toolName === "edit_file";
    if (isFileWriteTool) {
      const candidatePaths = [];
      const topPath =
        args.Path ??
        args.TargetFile ??
        args.path ??
        args.targetFile ??
        args.file_path ??
        args.filePath ??
        "";
      if (topPath) {
        candidatePaths.push(topPath);
      }
      if (Array.isArray(args.edits)) {
        for (const editItem of args.edits) {
          if (editItem && typeof editItem === "object") {
            const p =
              editItem.file_path ??
              editItem.filePath ??
              editItem.path ??
              editItem.Path ??
              "";
            if (p) candidatePaths.push(p);
          }
        }
      }

      for (const targetPath of candidatePaths) {
        const targetRoot = pickWorkspaceRoot(
          workspaceRoots,
          targetPath,
          effectiveCwd,
        );
        const loaded = loadGuardPolicyForRoot(targetRoot, activeSlice);
        if (loaded.error) {
          return { decision: "deny", reason: loaded.error };
        }
        const fileDecision = inspectTargetPath(targetPath, {
          root: targetRoot,
          cwd: effectiveCwd,
          ctx: loaded.ctx,
          respectOutside: false,
        });
        if (fileDecision.decision !== "allow") {
          return fileDecision;
        }
        if (activeSlice && !fileDecision.outside && fileDecision.rel !== null) {
          const sliceDecision = checkSliceBoundary(
            fileDecision.rel,
            activeSlice,
            loaded.allowList,
          );
          if (sliceDecision.decision !== "allow") {
            return sliceDecision;
          }
        }
      }

      return { decision: "allow" };
    }

    if (toolName === "run_command") {
      const commandLine =
        args.CommandLine ?? args.commandLine ?? args.command ?? "";
      const cmdCwd = path.resolve(
        args.Cwd ?? args.cwd ?? effectiveCwd ?? primaryRoot,
      );
      const targetRoot = pickWorkspaceRoot(workspaceRoots, cmdCwd, cmdCwd);
      const loaded = loadGuardPolicyForRoot(targetRoot, activeSlice);
      if (loaded.error) {
        return { decision: "deny", reason: loaded.error };
      }
      return evaluateShellCommand(commandLine, {
        root: targetRoot,
        cwd: cmdCwd,
        ctx: loaded.ctx,
        respectOutside: false,
        gitPushDecision: "force_ask",
        gitPushForceDecision: "force_ask",
        gitAskDecision: "force_ask",
        sliceCheck: activeSlice
          ? (relOrRaw) =>
              checkSliceBoundary(relOrRaw, activeSlice, loaded.allowList)
          : undefined,
      });
    }

    return { decision: "allow" };
  } catch {
    return { decision: "allow" };
  }
}

export function formatPreToolUseWireOutput(result) {
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
      const result = evaluatePreToolUse(payload);
      const wireOutput = formatPreToolUseWireOutput(result, payload);
      process.stdout.write(`${JSON.stringify(wireOutput)}\n`);
    })
    .catch(() => {
      process.stdout.write(`${JSON.stringify({ decision: "allow" })}\n`);
    });
}
