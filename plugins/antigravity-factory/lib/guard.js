import path from "node:path";

/** Safe environment template basenames that remain writable. */
export const ALLOWED_ENV_TEMPLATES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.test",
]);

/** Known SSH/TLS private key filenames blocked from model edits. */
export const PRIVATE_KEY_BASENAMES = new Set([
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
]);

const CATASTROPHIC_RM_TARGETS = new Set([
  "/",
  "/.",
  "/..",
  "/*",
  "~",
  "~/",
  "~/*",
  "$HOME",
  "${HOME}",
  "$HOME/",
  "${HOME}/",
  "$HOME/*",
  "${HOME}/*",
]);

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const COMMAND_PREFIX_WRAPPERS = new Set([
  "sudo",
  "env",
  "command",
  "nohup",
  "nice",
  "time",
  "exec",
]);
const SHELL_WRAPPER_CMDS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash"]);
const DOWNLOAD_CMDS = new Set(["curl", "wget", "fetch"]);
const PIPE_EXEC_TARGETS = new Set([
  ...SHELL_WRAPPER_CMDS,
  "python",
  "python3",
  "perl",
  "ruby",
  "node",
]);
const DOCKER_PRUNE_SCOPES = new Set([
  "system",
  "volume",
  "container",
  "image",
  "network",
  "builder",
  "buildx",
]);
const DOCKER_VALUE_FLAGS = new Set([
  "-H",
  "--host",
  "-c",
  "--context",
  "-l",
  "--log-level",
  "--config",
  "--tlscacert",
  "--tlscert",
  "--tlskey",
]);
const GIT_GLOBAL_VALUE_FLAGS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--exec-path",
  "--config-env",
]);
const NO_VERIFY_GIT_SUBCOMMANDS = new Set([
  "commit",
  "merge",
  "push",
  "am",
  "cherry-pick",
  "revert",
  "rebase",
]);

function toPosix(value) {
  return String(value || "").replace(/\\/g, "/");
}

/**
 * Unquote a single shell token while preserving inner variable markers ($HOME)
 * and unescaping double-quoted backslash sequences.
 */
export function unquoteShellToken(token) {
  if (typeof token !== "string" || token.length === 0) return "";
  let out = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < token.length; i += 1) {
    const ch = token[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else out += ch;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") {
        const next = token[i + 1];
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          out += next;
          i += 1;
          continue;
        }
      }
      if (ch === '"') inDouble = false;
      else out += ch;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === "\\" && i + 1 < token.length) {
      out += token[i + 1];
      i += 1;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Tokenize a single shell segment respecting quotes, escapes, and $(...)/`...` spans.
 */
export function tokenizeShellSegment(segment) {
  const tokens = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let substDepth = 0;

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (inSingle) {
      current += ch;
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === "\\" && i + 1 < segment.length) {
      current += ch + segment[i + 1];
      i += 1;
      continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === "$" && segment[i + 1] === "(") {
        substDepth += 1;
        current += "(";
        i += 1;
      } else if (substDepth > 0 && ch === ")") {
        substDepth -= 1;
      } else if (ch === "`") {
        inBacktick = !inBacktick;
      } else if (ch === '"' && substDepth === 0 && !inBacktick) {
        inDouble = false;
      }
      continue;
    }
    if (inBacktick) {
      current += ch;
      if (ch === "`") inBacktick = false;
      continue;
    }
    if (substDepth > 0) {
      current += ch;
      if (ch === "(") substDepth += 1;
      else if (ch === ")") substDepth -= 1;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
    } else if (ch === '"') {
      inDouble = true;
      current += ch;
    } else if (ch === "`") {
      inBacktick = true;
      current += ch;
    } else if (ch === "$" && segment[i + 1] === "(") {
      substDepth = 1;
      current += "$(";
      i += 1;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }

  if (current.length > 0) tokens.push(current);
  return tokens;
}

/**
 * Split a shell command line into pipelines (`;`, `&&`, `||`, `&`, newline),
 * each consisting of pipe-separated (`|` / `|&`) command segments.
 */
export function splitShellPipelines(commandLine) {
  const pipelines = [];
  let currentPipeline = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let parenDepth = 0;

  const pushSegment = () => {
    const trimmed = current.trim();
    if (trimmed) currentPipeline.push(trimmed);
    current = "";
  };

  const pushPipeline = () => {
    pushSegment();
    if (currentPipeline.length > 0) pipelines.push(currentPipeline);
    currentPipeline = [];
  };

  for (let i = 0; i < commandLine.length; i += 1) {
    const ch = commandLine[i];
    const next = commandLine[i + 1];

    if (inSingle) {
      current += ch;
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === "\\" && i + 1 < commandLine.length) {
      current += ch + next;
      i += 1;
      continue;
    }
    if (inBacktick) {
      current += ch;
      if (ch === "`") inBacktick = false;
      continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === "`") inBacktick = true;
      else if (ch === "$" && next === "(") {
        parenDepth += 1;
        current += "(";
        i += 1;
      } else if (parenDepth > 0 && ch === ")") {
        parenDepth -= 1;
      } else if (ch === '"' && parenDepth === 0) {
        inDouble = false;
      }
      continue;
    }

    if (parenDepth > 0) {
      current += ch;
      if (ch === "(") parenDepth += 1;
      else if (ch === ")") parenDepth -= 1;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      current += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
      continue;
    }
    if (ch === "`") {
      inBacktick = true;
      current += ch;
      continue;
    }
    if (ch === "$" && next === "(") {
      parenDepth = 1;
      current += "$(";
      i += 1;
      continue;
    }

    if (ch === "\n" || ch === ";") {
      pushPipeline();
      continue;
    }
    if (ch === "&" && next === "&") {
      pushPipeline();
      i += 1;
      continue;
    }
    if (ch === "|" && next === "|") {
      pushPipeline();
      i += 1;
      continue;
    }
    if (ch === "&") {
      const prev = i > 0 ? commandLine[i - 1] : "";
      const isRedirectAmp = prev === ">" || prev === "<" || next === ">";
      if (!isRedirectAmp) {
        pushPipeline();
        continue;
      }
    }
    if (ch === "|") {
      const prev = i > 0 ? commandLine[i - 1] : "";
      if (prev === ">") {
        // Handle `>|` noclobber redirection inside the same segment.
        current += ch;
        continue;
      }
      pushSegment();
      if (next === "&") i += 1;
      continue;
    }

    current += ch;
  }

  pushPipeline();
  return pipelines;
}

/**
 * Extract active `$(...)` and backtick command substitution inner bodies from a segment
 * (skipping single-quoted strings where substitutions do not run).
 */
export function extractCommandSubstitutions(segment) {
  const inner = [];
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === "\\" && i + 1 < segment.length) {
      i += 1;
      continue;
    }
    if (ch === "'") {
      if (!inDouble) inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (ch === "`") {
      let j = i + 1;
      let body = "";
      while (j < segment.length) {
        if (segment[j] === "\\" && j + 1 < segment.length) {
          body += segment[j + 1];
          j += 2;
          continue;
        }
        if (segment[j] === "`") break;
        body += segment[j];
        j += 1;
      }
      if (body.trim()) inner.push(body);
      i = j;
      continue;
    }
    if (ch === "$" && segment[i + 1] === "(") {
      // Skip arithmetic `$(( ... ))` which cannot run arbitrary commands on its own unless nested
      let depth = 1;
      let j = i + 2;
      let body = "";
      let subSingle = false;
      let subDouble = false;
      while (j < segment.length && depth > 0) {
        const c = segment[j];
        if (subSingle) {
          body += c;
          if (c === "'") subSingle = false;
          j += 1;
          continue;
        }
        if (c === "\\" && j + 1 < segment.length) {
          body += c + segment[j + 1];
          j += 2;
          continue;
        }
        if (c === "'" && !subDouble) {
          subSingle = true;
          body += c;
          j += 1;
          continue;
        }
        if (c === '"') {
          subDouble = !subDouble;
          body += c;
          j += 1;
          continue;
        }
        if (!subDouble) {
          if (c === "(") depth += 1;
          else if (c === ")") {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        body += c;
        j += 1;
      }
      if (body.trim()) inner.push(body);
      i = j;
    }
  }
  return inner;
}

/**
 * Normalize CONTRACT.md guard context fields (`control_dir`, `frozen`, `holdout_markers`).
 */
export function normalizeGuardContext(ctx = {}) {
  const rawControls = ctx.controlPrefixes
    ? ctx.controlPrefixes
    : ctx.control_dir
      ? [ctx.control_dir]
      : [".factory/"];
  const controlPrefixes = rawControls
    .filter((v) => typeof v === "string" && v.trim())
    .map((v) => {
      const clean = toPosix(v.trim()).replace(/^\.\//, "");
      return clean.endsWith("/") ? clean : `${clean}/`;
    });

  const rawFrozen = Array.isArray(ctx.frozen)
    ? ctx.frozen
    : ctx.frozen instanceof Set
      ? [...ctx.frozen]
      : [];
  const frozenSet = new Set(
    rawFrozen
      .filter((v) => typeof v === "string" && v.trim())
      .map((v) => path.posix.normalize(toPosix(v.trim())).replace(/^\.\//, "")),
  );

  const rawHoldout = Array.isArray(ctx.holdoutMarkers)
    ? ctx.holdoutMarkers
    : Array.isArray(ctx.holdout_markers)
      ? ctx.holdout_markers
      : ["holdout/", ".holdout."];
  const holdoutMarkers = rawHoldout
    .filter((v) => typeof v === "string" && v.trim())
    .map((v) => toPosix(v.trim()).toLowerCase());

  return {
    controlPrefixes: controlPrefixes.length > 0 ? controlPrefixes : [".factory/"],
    frozenSet,
    holdoutMarkers: holdoutMarkers.length > 0 ? holdoutMarkers : ["holdout/", ".holdout."],
  };
}

/**
 * Resolve a target path against `root` / `cwd` and report whether it escapes `root`.
 */
export function relativeToRoot(rawPath, root, cwd) {
  const cleaned = unquoteShellToken(String(rawPath || "")).trim();
  const posixRaw = toPosix(cleaned);
  if (
    !posixRaw ||
    posixRaw === "~" ||
    posixRaw.startsWith("~/") ||
    posixRaw.startsWith("$HOME") ||
    posixRaw.startsWith("${HOME}")
  ) {
    return { outside: true, rel: null, normalized: posixRaw };
  }

  const absRoot = path.posix.resolve(toPosix(root || "/"));
  const baseDir = cwd
    ? path.posix.resolve(absRoot, toPosix(cwd))
    : absRoot;
  const resolved = path.posix.resolve(baseDir, posixRaw);
  const rel = path.posix.relative(absRoot, resolved);
  const outside =
    rel === ".." ||
    rel.startsWith("../") ||
    path.posix.isAbsolute(rel);

  return {
    outside,
    rel: outside ? null : rel === "" ? "." : rel,
    normalized: resolved,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesHoldoutMarker(candidatePath, holdoutMarkers) {
  const lower = candidatePath.toLowerCase();
  const segments = lower.split("/").filter(Boolean);
  for (const marker of holdoutMarkers) {
    if (marker.endsWith("/")) {
      const dirSeg = marker.slice(0, -1);
      if (dirSeg && segments.includes(dirSeg)) return true;
    } else if (lower.includes(marker)) {
      return true;
    }
  }
  return false;
}

/**
 * Inspect a single file/directory write or delete target against secret, git-internal,
 * control-dir, holdout, and frozen-file guard rules.
 */
export function inspectTargetPath(
  rawPath,
  { root, cwd, ctx, respectOutside = false } = {},
) {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    return { decision: "allow" };
  }

  const unquoted = unquoteShellToken(rawPath).trim();
  if (!unquoted) return { decision: "allow" };

  const policy = normalizeGuardContext(ctx);
  let checkPath = path.posix.normalize(toPosix(unquoted));
  if (checkPath.length > 1 && checkPath.endsWith("/")) {
    checkPath = checkPath.slice(0, -1);
  }

  let rel = null;
  let outside = false;
  if (root) {
    const info = relativeToRoot(unquoted, root, cwd);
    outside = info.outside;
    if (respectOutside && info.outside) {
      return { decision: "allow", outside: true, rel: null };
    }
    rel = info.rel;
    if (!info.outside && rel !== null) {
      checkPath = rel === "." ? "" : rel;
    }
  } else {
    rel = checkPath.replace(/^\.?\//, "");
  }

  const normalizedCheck = checkPath.replace(/^\.?\//, "");
  if (
    normalizedCheck === ".git" ||
    normalizedCheck.startsWith(".git/") ||
    (!respectOutside && /(^|\/)\.git(\/|$)/i.test(normalizedCheck))
  ) {
    return {
      decision: "deny",
      reason: `Blocked direct modification of git internals (${unquoted}).`,
      rel,
    };
  }

  for (const prefix of policy.controlPrefixes) {
    const bare = prefix.replace(/\/+$/, "");
    if (
      normalizedCheck === bare ||
      normalizedCheck.startsWith(prefix) ||
      (!respectOutside &&
        new RegExp(`(^|/)${escapeRegExp(bare)}(/|$)`, "i").test(normalizedCheck))
    ) {
      return {
        decision: "deny",
        reason: `Blocked direct modification of factory control directory (${unquoted}).`,
        rel,
      };
    }
  }

  if (matchesHoldoutMarker(normalizedCheck, policy.holdoutMarkers)) {
    return {
      decision: "deny",
      reason: `Blocked modification of protected holdout test path (${unquoted}).`,
      rel,
    };
  }

  if (policy.frozenSet.size > 0) {
    const candidateRel = rel === "." ? "" : rel || normalizedCheck;
    for (const frozenPath of policy.frozenSet) {
      const cleanFrozen = frozenPath.replace(/\/+$/, "");
      if (
        candidateRel === cleanFrozen ||
        (cleanFrozen && candidateRel.startsWith(`${cleanFrozen}/`))
      ) {
        return {
          decision: "deny",
          reason: `Blocked modification of frozen contract/test file (${unquoted}).`,
          rel,
        };
      }
    }
  }

  const baseLower = path.posix.basename(normalizedCheck).toLowerCase();
  if (
    (baseLower === ".env" || baseLower.startsWith(".env.")) &&
    !ALLOWED_ENV_TEMPLATES.has(baseLower)
  ) {
    return {
      decision: "deny",
      reason: `Blocked secret file modification (${unquoted}). Only safe templates like .env.example may be edited.`,
      rel,
    };
  }

  if (
    PRIVATE_KEY_BASENAMES.has(baseLower) ||
    baseLower.endsWith(".pem") ||
    baseLower.endsWith(".key")
  ) {
    return {
      decision: "deny",
      reason: `Blocked private key material write (${unquoted}).`,
      rel,
    };
  }

  return { decision: "allow", rel, outside };
}

function normalizeRmTarget(rawTarget) {
  const cleaned = unquoteShellToken(rawTarget).trim();
  if (!cleaned) return "";
  if (cleaned === "~" || cleaned.startsWith("~/")) {
    if (cleaned === "~") return "~";
    const normHome = path.posix.normalize(cleaned.slice(2));
    if (normHome === "." || normHome === "") return "~/";
    if (normHome === "*") return "~/*";
    return `~/${normHome}`;
  }
  if (cleaned.startsWith("$HOME") || cleaned.startsWith("${HOME}")) {
    const prefix = cleaned.startsWith("${HOME}") ? "${HOME}" : "$HOME";
    const rest = cleaned.slice(prefix.length);
    if (!rest) return prefix;
    const collapsed = rest.replace(/\/+/g, "/");
    if (collapsed === "/" || collapsed === "/.") return `${prefix}/`;
    if (collapsed === "/*") return `${prefix}/*`;
    return `${prefix}${collapsed}`;
  }
  if (cleaned === "/*" || /^\/+\*$/.test(cleaned)) return "/*";
  if (cleaned === "/.." || /^\/+\.\.$/.test(cleaned)) return "/..";
  if (cleaned === "/." || /^\/+\.$/.test(cleaned)) return "/.";
  const collapsed = cleaned.replace(/\/+/g, "/");
  const normalized = path.posix.normalize(collapsed);
  if (normalized === "/" || normalized === "/.") return "/";
  return normalized;
}

function isCatastrophicRm(rawTarget, cwd) {
  const norm = normalizeRmTarget(rawTarget);
  if (CATASTROPHIC_RM_TARGETS.has(norm)) return true;
  if (
    cwd &&
    norm &&
    !norm.startsWith("~") &&
    !norm.startsWith("$HOME") &&
    !norm.startsWith("${HOME}")
  ) {
    const resolved = path.posix.resolve(toPosix(cwd), norm);
    if (resolved === "/") return true;
  }
  return false;
}

function stripCommandPrefixes(rawTokens) {
  const envAssignments = [];
  let idx = 0;

  while (idx < rawTokens.length) {
    const tok = unquoteShellToken(rawTokens[idx]);
    if (tok === "env") {
      idx += 1;
      while (idx < rawTokens.length) {
        const nextTok = unquoteShellToken(rawTokens[idx]);
        if (ENV_ASSIGNMENT_RE.test(nextTok)) {
          envAssignments.push(nextTok);
          idx += 1;
        } else if (nextTok.startsWith("-")) {
          if (nextTok === "-u" || nextTok === "-C" || nextTok === "--unset" || nextTok === "--chdir") {
            idx += 2;
          } else {
            idx += 1;
          }
        } else {
          break;
        }
      }
      continue;
    }
    if (ENV_ASSIGNMENT_RE.test(tok)) {
      envAssignments.push(tok);
      idx += 1;
      continue;
    }
    if (COMMAND_PREFIX_WRAPPERS.has(tok)) {
      idx += 1;
      while (idx < rawTokens.length && unquoteShellToken(rawTokens[idx]).startsWith("-")) {
        const opt = unquoteShellToken(rawTokens[idx]);
        if (tok === "sudo" && (opt === "-u" || opt === "-g" || opt === "-C" || opt === "-h")) {
          idx += 2;
        } else if (tok === "nice" && opt === "-n") {
          idx += 2;
        } else {
          idx += 1;
        }
      }
      continue;
    }
    break;
  }

  return { envAssignments, tokens: rawTokens.slice(idx) };
}

function extractRedirects(rawTokens) {
  const redirectTargets = [];
  const commandTokens = [];

  for (let i = 0; i < rawTokens.length; i += 1) {
    const raw = rawTokens[i];
    const tok = unquoteShellToken(raw);

    if (/^(?:\d+|&)?(?:>>?|>\||&>>?)$/.test(tok)) {
      if (i + 1 < rawTokens.length) {
        const nextTok = unquoteShellToken(rawTokens[i + 1]);
        if (!/^&\d+$|^&-$/.test(nextTok)) redirectTargets.push(nextTok);
        i += 1;
      }
      continue;
    }

    const attached = tok.match(/^(?:\d+|&)?(?:>>?|>\||&>>?)(.+)$/);
    if (attached) {
      const target = attached[1];
      if (!/^&\d+$|^&-$/.test(target)) redirectTargets.push(target);
      continue;
    }

    commandTokens.push(raw);
  }

  return { redirectTargets, commandTokens };
}

function parseCopyMoveDestinations(args, { includeSources = false } = {}) {
  let targetDir = null;
  const positional = [];
  let stopFlags = false;
  const valueFlags = new Set(["-t", "--target-directory", "-S", "--suffix"]);

  for (let i = 0; i < args.length; i += 1) {
    const tok = unquoteShellToken(args[i]);
    if (!stopFlags && tok === "--") {
      stopFlags = true;
      continue;
    }
    if (!stopFlags && tok.startsWith("--target-directory=")) {
      targetDir = tok.slice("--target-directory=".length);
      continue;
    }
    if (!stopFlags && tok.startsWith("-t") && tok.length > 2 && tok !== "-target-directory") {
      targetDir = tok.slice(2);
      continue;
    }
    if (!stopFlags && valueFlags.has(tok)) {
      const next = i + 1 < args.length ? unquoteShellToken(args[i + 1]) : null;
      if ((tok === "-t" || tok === "--target-directory") && next) targetDir = next;
      i += 1;
      continue;
    }
    if (!stopFlags && tok.startsWith("-") && tok !== "-") {
      continue;
    }
    positional.push(tok);
  }

  if (includeSources) {
    const out = [...positional];
    if (targetDir) out.push(targetDir);
    return out;
  }
  if (targetDir) return [targetDir];
  if (positional.length >= 2) return [positional[positional.length - 1]];
  if (positional.length === 1 && targetDir === null) return [positional[0]];
  return [];
}

function parseInPlaceTargets(cmd, args) {
  let inPlace = false;
  let hasExplicitScript = false;
  const positional = [];
  let stopFlags = false;

  for (let i = 0; i < args.length; i += 1) {
    const tok = unquoteShellToken(args[i]);
    if (!stopFlags && tok === "--") {
      stopFlags = true;
      continue;
    }
    if (!stopFlags && tok.startsWith("-") && tok !== "-") {
      if (tok === "--in-place" || tok.startsWith("--in-place=")) {
        inPlace = true;
        continue;
      }
      if (/^-[A-Za-z]*i/.test(tok) || (cmd === "sed" && tok.startsWith("-i"))) {
        inPlace = true;
      }
      if (tok === "-e" || tok === "-f" || tok === "--expression" || tok === "--file") {
        hasExplicitScript = true;
        i += 1;
      }
      continue;
    }
    positional.push(tok);
  }

  if (!inPlace) return [];
  if (hasExplicitScript) return positional;
  return positional.length > 1 ? positional.slice(1) : [];
}

function parseGitSubcommand(args) {
  let i = 0;
  while (i < args.length) {
    const tok = unquoteShellToken(args[i]);
    if (tok === "--") {
      i += 1;
      break;
    }
    if (tok.startsWith("-")) {
      if (GIT_GLOBAL_VALUE_FLAGS.has(tok)) {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    return { subcommand: tok, subArgs: args.slice(i + 1).map(unquoteShellToken) };
  }
  if (i < args.length) {
    return {
      subcommand: unquoteShellToken(args[i]),
      subArgs: args.slice(i + 1).map(unquoteShellToken),
    };
  }
  return { subcommand: "", subArgs: [] };
}

function hasShortFlag(tokens, flagChar) {
  for (const tok of tokens) {
    if (tok === "--") break;
    if (tok.startsWith("-") && !tok.startsWith("--") && tok.length > 1) {
      if (tok.slice(1).includes(flagChar)) return true;
    }
  }
  return false;
}

/**
 * Evaluate a single shell command line against CONTRACT.md §8 rules and optional slice checks.
 */
export function evaluateShellCommand(
  commandLine,
  {
    root,
    cwd,
    ctx,
    respectOutside = false,
    gitPushDecision = "deny",
    gitPushForceDecision = gitPushDecision,
    gitAskDecision = "ask",
    sliceCheck,
    depth = 0,
  } = {},
) {
  if (typeof commandLine !== "string" || commandLine.trim() === "") {
    return { decision: "allow" };
  }
  if (depth > 5) {
    return {
      decision: "deny",
      reason: "Blocked excessively nested shell command expansion.",
    };
  }

  if (/:\(\)\s*\{[^}]*:\s*\|\s*:[^}]*\}\s*;\s*:/.test(commandLine)) {
    return { decision: "deny", reason: "Blocked catastrophic shell fork bomb." };
  }

  const checkPath = (rawTarget) => {
    const res = inspectTargetPath(rawTarget, { root, cwd, ctx, respectOutside });
    if (res.decision !== "allow") return res;
    if (sliceCheck && !res.outside) {
      const sliceRes = sliceCheck(rawTarget);
      if (sliceRes && sliceRes.decision !== "allow") return sliceRes;
    }
    return { decision: "allow" };
  };

  let pendingAsk = null;
  const recordAsk = (reason) => {
    if (!pendingAsk) pendingAsk = { decision: gitAskDecision, reason };
  };

  const pipelines = splitShellPipelines(commandLine);

  for (const pipeline of pipelines) {
    let sawDownloader = false;

    for (const segment of pipeline) {
      for (const inner of extractCommandSubstitutions(segment)) {
        const subRes = evaluateShellCommand(inner, {
          root,
          cwd,
          ctx,
          respectOutside,
          gitPushDecision,
          gitPushForceDecision,
          gitAskDecision,
          sliceCheck,
          depth: depth + 1,
        });
        if (subRes.decision === "deny") return subRes;
        if (subRes.decision !== "allow") recordAsk(subRes.reason);
      }

      const rawTokens = tokenizeShellSegment(segment);
      if (rawTokens.length === 0) continue;

      const { redirectTargets, commandTokens } = extractRedirects(rawTokens);
      for (const target of redirectTargets) {
        const targetRes = checkPath(target);
        if (targetRes.decision !== "allow") return targetRes;
      }

      const { envAssignments, tokens } = stripCommandPrefixes(commandTokens);
      for (const envPair of envAssignments) {
        if (/^HUSKY=0$/i.test(envPair)) {
          return {
            decision: "deny",
            reason: "Blocked hook bypass via HUSKY=0.",
          };
        }
      }

      if (tokens.length === 0) continue;

      const cmdToken = unquoteShellToken(tokens[0]);
      const cmd = path.posix.basename(toPosix(cmdToken)).toLowerCase();
      const args = tokens.slice(1);
      const unquotedArgs = args.map(unquoteShellToken);

      if (DOWNLOAD_CMDS.has(cmd)) {
        sawDownloader = true;
      } else if (sawDownloader && PIPE_EXEC_TARGETS.has(cmd)) {
        return {
          decision: "deny",
          reason: `Blocked pipe-to-shell remote execution (${cmd}).`,
        };
      }

      if (cmd === "mkfs" || cmd.startsWith("mkfs.")) {
        return {
          decision: "deny",
          reason: "Blocked catastrophic filesystem formatting command (mkfs).",
        };
      }

      if (SHELL_WRAPPER_CMDS.has(cmd)) {
        for (let i = 0; i < unquotedArgs.length; i += 1) {
          const arg = unquotedArgs[i];
          if (arg === "-c" || /^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) {
            if (i + 1 < unquotedArgs.length) {
              const nestedRes = evaluateShellCommand(unquotedArgs[i + 1], {
                root,
                cwd,
                ctx,
                respectOutside,
                gitPushDecision,
                gitPushForceDecision,
                gitAskDecision,
                sliceCheck,
                depth: depth + 1,
              });
              if (nestedRes.decision === "deny") return nestedRes;
              if (nestedRes.decision !== "allow") recordAsk(nestedRes.reason);
            }
            break;
          }
          if (!arg.startsWith("-")) break;
        }
        continue;
      }

      if (cmd === "rm") {
        let recursive = false;
        let stopFlags = false;
        const rmTargets = [];
        for (const arg of unquotedArgs) {
          if (!stopFlags && arg === "--") {
            stopFlags = true;
            continue;
          }
          if (!stopFlags && arg.startsWith("-") && arg !== "-") {
            if (
              arg === "--recursive" ||
              /^-[A-Za-z]*[rR]/.test(arg)
            ) {
              recursive = true;
            }
            continue;
          }
          rmTargets.push(arg);
        }
        for (const target of rmTargets) {
          if (
            (recursive ||
              CATASTROPHIC_RM_TARGETS.has(normalizeRmTarget(target))) &&
            isCatastrophicRm(target, cwd)
          ) {
            return {
              decision: "deny",
              reason: `Blocked catastrophic recursive delete targeting "${target}".`,
            };
          }
          const targetRes = checkPath(target);
          if (targetRes.decision !== "allow") return targetRes;
        }
        continue;
      }

      if (cmd === "mv") {
        for (const target of parseCopyMoveDestinations(args, { includeSources: true })) {
          const res = checkPath(target);
          if (res.decision !== "allow") return res;
        }
        continue;
      }

      if (cmd === "cp" || cmd === "ln" || cmd === "install") {
        for (const target of parseCopyMoveDestinations(args, { includeSources: false })) {
          const res = checkPath(target);
          if (res.decision !== "allow") return res;
        }
        continue;
      }

      if (cmd === "tee" || cmd === "touch" || cmd === "truncate") {
        let stopFlags = false;
        for (let i = 0; i < unquotedArgs.length; i += 1) {
          const arg = unquotedArgs[i];
          if (!stopFlags && arg === "--") {
            stopFlags = true;
            continue;
          }
          if (!stopFlags && arg.startsWith("-") && arg !== "-") {
            if (
              cmd === "truncate" &&
              (arg === "-s" || arg === "-r" || arg === "--size" || arg === "--reference")
            ) {
              i += 1;
            }
            continue;
          }
          const res = checkPath(arg);
          if (res.decision !== "allow") return res;
        }
        continue;
      }

      if (cmd === "sed" || cmd === "perl") {
        for (const target of parseInPlaceTargets(cmd, args)) {
          const res = checkPath(target);
          if (res.decision !== "allow") return res;
        }
        continue;
      }

      if (cmd === "dd") {
        for (const arg of unquotedArgs) {
          if (arg.startsWith("of=")) {
            const res = checkPath(arg.slice(3));
            if (res.decision !== "allow") return res;
          }
        }
        continue;
      }

      if (cmd === "docker" || cmd === "podman") {
        let i = 0;
        while (i < unquotedArgs.length) {
          const arg = unquotedArgs[i];
          if (arg.startsWith("-")) {
            if (DOCKER_VALUE_FLAGS.has(arg)) i += 2;
            else i += 1;
            continue;
          }
          break;
        }
        const sub = (unquotedArgs[i] || "").toLowerCase();
        const sub2 = (unquotedArgs[i + 1] || "").toLowerCase();
        if (
          sub === "prune" ||
          (DOCKER_PRUNE_SCOPES.has(sub) && sub2 === "prune")
        ) {
          return {
            decision: "deny",
            reason: `Blocked host-wide ${cmd} ${sub}${sub2 ? ` ${sub2}` : ""} operation.`,
          };
        }
        continue;
      }

      if (cmd === "git") {
        if (unquotedArgs.some((a) => /core\.hooksPath=/i.test(a))) {
          return {
            decision: "deny",
            reason: "Blocked hook bypass via core.hooksPath override.",
          };
        }
        const { subcommand, subArgs } = parseGitSubcommand(args);
        if (
          subArgs.includes("--no-verify") ||
          (NO_VERIFY_GIT_SUBCOMMANDS.has(subcommand) &&
            (subcommand === "commit" || subcommand === "merge") &&
            hasShortFlag(subArgs, "n"))
        ) {
          return {
            decision: "deny",
            reason: `Blocked verification hook bypass (--no-verify) in git ${subcommand}.`,
          };
        }

        if (subcommand === "push") {
          const isForce =
            subArgs.some(
              (a) =>
                a === "--force" ||
                a === "--force-with-lease" ||
                a === "--force-if-includes",
            ) || hasShortFlag(subArgs, "f");
          const decision = isForce ? gitPushForceDecision : gitPushDecision;
          const reason = isForce
            ? "Force-pushing (`git push --force`) can overwrite remote history."
            : "Pushing (`git push`) alters remote repository state.";
          if (decision === "deny") return { decision: "deny", reason };
          recordAsk(reason);
          continue;
        }

        if (subcommand === "reset" && subArgs.includes("--hard")) {
          recordAsk("Destructive `git reset --hard` discards uncommitted changes.");
          continue;
        }

        if (
          subcommand === "clean" &&
          (subArgs.includes("--force") || hasShortFlag(subArgs, "f"))
        ) {
          recordAsk("Destructive `git clean -f` deletes untracked files.");
          continue;
        }

        if (
          subcommand === "rebase" &&
          (subArgs.includes("--interactive") || hasShortFlag(subArgs, "i"))
        ) {
          recordAsk("Interactive rebase (`git rebase -i`) rewrites commit history.");
          continue;
        }

        if (subcommand === "checkout" || subcommand === "restore") {
          const dashIdx = subArgs.indexOf("--");
          const pathSpecs =
            dashIdx >= 0
              ? subArgs.slice(dashIdx + 1)
              : subcommand === "restore"
                ? subArgs.filter((a, idx) => {
                    if (a.startsWith("-")) return false;
                    const prev = idx > 0 ? subArgs[idx - 1] : "";
                    return prev !== "-s" && prev !== "--source" && prev !== "--conflict";
                  })
                : [];
          for (const target of pathSpecs) {
            const res = checkPath(target);
            if (res.decision !== "allow") return res;
          }
        }
      }
    }
  }

  return pendingAsk || { decision: "allow" };
}

/**
 * Shared CONTRACT.md §8 guard entry point used by cross-factory guard vector tests.
 * Returns `"allow" | "deny" | "ask"`.
 */
export function decideContractCase({
  tool,
  input,
  root = "/repo",
  cwd = root,
  ctx = {},
  unattended = false,
} = {}) {
  let result;
  if (tool === "write") {
    result = inspectTargetPath(String(input || ""), {
      root,
      cwd,
      ctx,
      respectOutside: true,
    });
  } else if (tool === "shell") {
    result = evaluateShellCommand(String(input || ""), {
      root,
      cwd,
      ctx,
      respectOutside: true,
      gitPushDecision: "deny",
      gitPushForceDecision: "deny",
      gitAskDecision: "ask",
    });
  } else {
    return "allow";
  }

  if (result.decision === "ask" && unattended) return "deny";
  return result.decision;
}
