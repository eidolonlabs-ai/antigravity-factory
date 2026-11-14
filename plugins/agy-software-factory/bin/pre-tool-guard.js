#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED_ENV_TEMPLATES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.test",
]);

const PRIVATE_KEY_BASENAMES = new Set([
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
]);

const CATASTROPHIC_RM_TARGETS = new Set([
  "/",
  "/*",
  "~",
  "~/",
  "~/*",
  "$HOME",
  "$HOME/",
  "$HOME/*",
  "${HOME}",
  "${HOME}/",
  "${HOME}/*",
]);

const GIT_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
]);

function stripWrappingQuotes(token) {
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1).trim();
  }
  return token;
}

function tokenizeShellSegment(segment) {
  const matches = segment.match(/(?:"[^"]*"|'[^']*'|[^\s"']+)+/g);
  return matches ? matches.map(stripWrappingQuotes) : [];
}

function splitShellSegments(commandLine) {
  const segments = [];
  let current = "";
  let quote = null;

  for (let i = 0; i < commandLine.length; i += 1) {
    const ch = commandLine[i];
    const prev = i > 0 ? commandLine[i - 1] : "";

    if (quote === "'") {
      current += ch;
      if (ch === "'") {
        quote = null;
      }
      continue;
    }

    if (quote === '"') {
      if (ch === '"' && prev !== "\\") {
        quote = null;
        current += ch;
        continue;
      }
      if (ch === "`" && prev !== "\\") {
        let sub = "";
        i += 1;
        while (i < commandLine.length) {
          if (commandLine[i] === "`" && commandLine[i - 1] !== "\\") {
            break;
          }
          sub += commandLine[i];
          i += 1;
        }
        if (sub.trim()) {
          segments.push(...splitShellSegments(sub));
        }
        continue;
      }
      if (ch === "$" && commandLine[i + 1] === "(" && prev !== "\\") {
        let sub = "";
        let depth = 1;
        i += 2;
        while (i < commandLine.length && depth > 0) {
          if (commandLine[i] === "(" && commandLine[i - 1] !== "\\") depth += 1;
          else if (commandLine[i] === ")" && commandLine[i - 1] !== "\\") depth -= 1;
          if (depth > 0) sub += commandLine[i];
          i += 1;
        }
        i -= 1;
        if (sub.trim()) {
          segments.push(...splitShellSegments(sub));
        }
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }

    if (
      (ch === ";" || ch === "\n" || ch === "(" || ch === ")" || ch === "`") &&
      prev !== "\\"
    ) {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }

    if ((ch === "&" || ch === "|") && commandLine[i + 1] === ch) {
      if (current.trim()) segments.push(current.trim());
      current = "";
      i += 1;
      continue;
    }

    if (ch === "|" || ch === "&") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }

    current += ch;
  }

  if (current.trim()) {
    segments.push(current.trim());
  }

  return segments;
}

function stripCommandPrefixes(tokens) {
  let idx = 0;
  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      idx += 1;
      continue;
    }
    if (tok === "sudo" || tok === "command" || tok === "env") {
      idx += 1;
      while (tok === "sudo" && idx < tokens.length && tokens[idx].startsWith("-")) {
        idx += 1;
      }
      continue;
    }
    break;
  }
  return tokens.slice(idx);
}

function normalizeRmTarget(rawTarget) {
  const trimmed = rawTarget.trim();
  if (!trimmed) return "";

  for (const homePrefix of ["~", "$HOME", "${HOME}"]) {
    if (trimmed === homePrefix) return homePrefix;
    if (trimmed.startsWith(`${homePrefix}/`)) {
      const suffix = trimmed.slice(homePrefix.length);
      if (/^\/+\*$/.test(suffix)) {
        return `${homePrefix}/*`;
      }
      const normSuffix = path.posix.normalize(suffix);
      if (normSuffix === "/" || normSuffix === "/.") {
        return `${homePrefix}/`;
      }
      const cleanSuffix = normSuffix.replace(/\/+$/, "");
      return `${homePrefix}${cleanSuffix}`;
    }
  }

  if (/^\/+\*$/.test(trimmed)) {
    return "/*";
  }

  if (trimmed.startsWith("/")) {
    const norm = path.posix.normalize(trimmed);
    if (norm === "/") return "/";
    return norm.replace(/\/+$/, "") || "/";
  }

  const normRel = path.posix.normalize(trimmed);
  return normRel.length > 1 ? normRel.replace(/\/+$/, "") : normRel;
}

function inspectFileTarget(rawPath) {
  if (!rawPath || typeof rawPath !== "string") {
    return { decision: "allow" };
  }

  const slashNormalized = rawPath.trim().replace(/\\/g, "/");
  if (!slashNormalized) {
    return { decision: "allow" };
  }

  const normalized =
    path.posix.normalize(slashNormalized).replace(/\/+$/, "") || "/";

  if (/(^|\/)\.git\/(config|HEAD)$/i.test(normalized)) {
    return {
      decision: "deny",
      reason: `Blocked modification of protected Git metadata file: ${normalized}`,
    };
  }

  if (/(^|\/)\.factory(\/|$)/i.test(normalized)) {
    return {
      decision: "deny",
      reason: `Blocked direct modification of protected factory verification state (${normalized}). Run "agy-factory verify" instead.`,
    };
  }

  const base = path.posix.basename(normalized);
  const lowerBase = base.toLowerCase();

  if (
    /(^|\/)holdout\//i.test(normalized) ||
    /\.holdout\.(test|spec)\.[a-z0-9]+$/i.test(lowerBase)
  ) {
    return {
      decision: "deny",
      reason: `Blocked modification of protected holdout test suite (${normalized}). Holdout tests cannot be edited by builder agents.`,
    };
  }

  if (
    (lowerBase === ".env" || lowerBase.startsWith(".env.")) &&
    !ALLOWED_ENV_TEMPLATES.has(lowerBase)
  ) {
    return {
      decision: "deny",
      reason: `Blocked write to secret environment file (${base}). Update .env.example instead or edit secrets manually.`,
    };
  }

  if (
    PRIVATE_KEY_BASENAMES.has(lowerBase) ||
    lowerBase.endsWith(".pem") ||
    lowerBase.endsWith(".key")
  ) {
    return {
      decision: "deny",
      reason: `Blocked write to private key file (${base}).`,
    };
  }

  return { decision: "allow" };
}

function inspectCommandLine(commandLine) {
  if (!commandLine || typeof commandLine !== "string") {
    return { decision: "allow" };
  }

  if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(commandLine)) {
    return {
      decision: "deny",
      reason: "Blocked catastrophic shell fork bomb.",
    };
  }

  if (/\bmkfs\.[A-Za-z0-9_-]+/.test(commandLine)) {
    return {
      decision: "deny",
      reason: "Blocked catastrophic filesystem formatting command (mkfs).",
    };
  }

  const segments = splitShellSegments(commandLine);
  let forceAskReason = null;

  for (const segment of segments) {
    const tokens = stripCommandPrefixes(tokenizeShellSegment(segment));
    if (tokens.length === 0) continue;

    const cmd = path.posix.basename(tokens[0]);
    const rest = tokens.slice(1);

    // Check output redirections (> or >>) targeting protected files (.factory/**, holdout/**, .env, keys, .git)
    for (let i = 0; i < tokens.length; i += 1) {
      const tok = tokens[i];
      let redirTarget = null;
      if (tok === ">" || tok === ">>" || tok === "1>" || tok === "1>>" || tok === "&>" || tok === "&>>") {
        redirTarget = tokens[i + 1] || null;
      } else if (/^(?:1|&)?>>?.+/.test(tok)) {
        redirTarget = tok.replace(/^(?:1|&)?>>?/, "");
      }
      if (redirTarget) {
        const targetCheck = inspectFileTarget(redirTarget);
        if (targetCheck.decision === "deny") {
          return targetCheck;
        }
      }
    }

    // Check file-writing/deleting commands targeting .factory/** or holdout/**
    if (
      cmd === "rm" ||
      cmd === "cp" ||
      cmd === "mv" ||
      cmd === "tee" ||
      cmd === "touch" ||
      cmd === "truncate"
    ) {
      const nonFlagArgs = rest.filter((tok) => !tok.startsWith("-"));
      const argsToInspect =
        cmd === "cp" && nonFlagArgs.length > 1
          ? [nonFlagArgs[nonFlagArgs.length - 1]]
          : nonFlagArgs;
      for (const tok of argsToInspect) {
        const targetCheck = inspectFileTarget(tok);
        if (targetCheck.decision === "deny") {
          return targetCheck;
        }
      }
    }

    if (cmd === "rm") {
      let hasRecursive = false;
      let hasForce = false;
      const targets = [];

      for (const tok of rest) {
        if (tok === "--recursive") {
          hasRecursive = true;
        } else if (tok === "--force") {
          hasForce = true;
        } else if (tok.startsWith("--")) {
          continue;
        } else if (tok.startsWith("-") && tok.length > 1) {
          if (/[rR]/.test(tok)) hasRecursive = true;
          if (/f/.test(tok)) hasForce = true;
        } else {
          targets.push(tok);
        }
      }

      if (hasRecursive && hasForce) {
        for (const target of targets) {
          const normalizedTarget = normalizeRmTarget(target);
          if (CATASTROPHIC_RM_TARGETS.has(normalizedTarget)) {
            return {
              decision: "deny",
              reason: `Blocked catastrophic recursive delete targeting "${target}".`,
            };
          }
        }
      }
    }

    if (cmd === "git" && !forceAskReason) {
      let subIdx = 0;
      while (subIdx < rest.length) {
        const tok = rest[subIdx];
        if (GIT_OPTIONS_WITH_VALUE.has(tok)) {
          subIdx += 2;
          continue;
        }
        if (tok.startsWith("-")) {
          subIdx += 1;
          continue;
        }
        break;
      }

      const gitSubcmd = rest[subIdx];
      const gitArgs = rest.slice(subIdx + 1);

      if (gitSubcmd === "reset" && gitArgs.includes("--hard")) {
        forceAskReason =
          "Destructive Git operation (`git reset --hard`) discards uncommitted changes.";
      } else if (
        gitSubcmd === "push" &&
        gitArgs.some(
          (arg) =>
            arg === "--force" ||
            arg === "-f" ||
            arg.startsWith("--force-with-lease")
        )
      ) {
        forceAskReason =
          "Force-pushing (`git push --force`) can overwrite remote history.";
      } else if (
        gitSubcmd === "clean" &&
        gitArgs.some(
          (arg) =>
            arg === "--force" ||
            (arg.startsWith("-") && !arg.startsWith("--") && arg.includes("f"))
        )
      ) {
        forceAskReason =
          "Destructive Git clean (`git clean -f`) permanently deletes untracked files.";
      }
    }
  }

  if (forceAskReason) {
    return {
      decision: "force_ask",
      reason: forceAskReason,
    };
  }

  return { decision: "allow" };
}

export function evaluatePreToolUse(payload) {
  try {
    if (!payload || typeof payload !== "object") {
      return { decision: "allow" };
    }

    const toolCall = payload.toolCall;
    if (!toolCall || typeof toolCall !== "object") {
      return { decision: "allow" };
    }

    const toolName = String(toolCall.name ?? "");
    const args =
      toolCall.args && typeof toolCall.args === "object" ? toolCall.args : {};

    if (toolName === "write_file" || toolName === "edit_file") {
      const targetPath =
        args.Path ?? args.TargetFile ?? args.path ?? args.targetFile ?? "";
      return inspectFileTarget(targetPath);
    }

    if (toolName === "run_command") {
      const commandLine =
        args.CommandLine ?? args.commandLine ?? args.command ?? "";
      return inspectCommandLine(commandLine);
    }

    return { decision: "allow" };
  } catch {
    return { decision: "allow" };
  }
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
      process.stdout.write(`${JSON.stringify(result)}\n`);
    })
    .catch(() => {
      process.stdout.write(`${JSON.stringify({ decision: "allow" })}\n`);
    });
}
