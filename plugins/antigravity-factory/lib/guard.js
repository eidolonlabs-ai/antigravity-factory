import fs from "node:fs";
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

function scanBacktick(str, startIdx) {
  let j = startIdx + 1;
  let body = "";
  while (j < str.length) {
    const ch = str[j];
    if (ch === "\\" && j + 1 < str.length) {
      body += str[j + 1];
      j += 2;
      continue;
    }
    if (ch === "`") {
      return { endIdx: j, body };
    }
    body += ch;
    j += 1;
  }
  return { endIdx: str.length - 1, body };
}

function scanCommandSubst(str, startIdx) {
  let j = startIdx + 2;
  let depth = 1;
  let inSingle = false;
  let inDouble = false;

  while (j < str.length && depth > 0) {
    const ch = str[j];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      j += 1;
      continue;
    }
    if (ch === "\\" && j + 1 < str.length) {
      j += 2;
      continue;
    }
    if (inDouble) {
      if (ch === "$" && str[j + 1] === "(") {
        const nested = scanCommandSubst(str, j);
        j = nested.endIdx + 1;
        continue;
      }
      if (ch === "`") {
        const bt = scanBacktick(str, j);
        j = bt.endIdx + 1;
        continue;
      }
      if (ch === '"') inDouble = false;
      j += 1;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === "`") {
      const bt = scanBacktick(str, j);
      j = bt.endIdx + 1;
      continue;
    } else if (ch === "$" && str[j + 1] === "(") {
      const nested = scanCommandSubst(str, j);
      j = nested.endIdx + 1;
      continue;
    } else if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return { endIdx: j, body: str.slice(startIdx + 2, j) };
      }
    }
    j += 1;
  }
  return { endIdx: str.length - 1, body: str.slice(startIdx + 2) };
}

function scanBalancedGroup(str, startIdx, openChar, closeChar) {
  let j = startIdx + 1;
  let depth = 1;
  let inSingle = false;
  let inDouble = false;

  while (j < str.length && depth > 0) {
    const ch = str[j];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      j += 1;
      continue;
    }
    if (ch === "\\" && j + 1 < str.length) {
      j += 2;
      continue;
    }
    if (inDouble) {
      if (ch === "$" && str[j + 1] === "(") {
        const nested = scanCommandSubst(str, j);
        j = nested.endIdx + 1;
        continue;
      }
      if (ch === "`") {
        const bt = scanBacktick(str, j);
        j = bt.endIdx + 1;
        continue;
      }
      if (ch === '"') inDouble = false;
      j += 1;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === "`") {
      const bt = scanBacktick(str, j);
      j = bt.endIdx + 1;
      continue;
    } else if (ch === "$" && str[j + 1] === "(") {
      const nested = scanCommandSubst(str, j);
      j = nested.endIdx + 1;
      continue;
    } else if (ch === openChar) {
      depth += 1;
    } else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return { endIdx: j, closed: true };
      }
    }
    j += 1;
  }
  return { endIdx: str.length - 1, closed: false };
}

/**
 * Tokenize a single shell segment respecting quotes, escapes, and $(...)/`...` spans.
 */
export function tokenizeShellSegment(segment) {
  const tokens = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

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
      if (ch === "$" && segment[i + 1] === "(") {
        const sub = scanCommandSubst(segment, i);
        current += segment.slice(i, sub.endIdx + 1);
        i = sub.endIdx;
        continue;
      }
      if (ch === "`") {
        const bt = scanBacktick(segment, i);
        current += segment.slice(i, bt.endIdx + 1);
        i = bt.endIdx;
        continue;
      }
      current += ch;
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
    } else if (ch === '"') {
      inDouble = true;
      current += ch;
    } else if (ch === "`") {
      const bt = scanBacktick(segment, i);
      current += segment.slice(i, bt.endIdx + 1);
      i = bt.endIdx;
    } else if (ch === "$" && segment[i + 1] === "(") {
      const sub = scanCommandSubst(segment, i);
      current += segment.slice(i, sub.endIdx + 1);
      i = sub.endIdx;
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
    if (inDouble) {
      if (ch === "`") {
        const bt = scanBacktick(commandLine, i);
        current += commandLine.slice(i, bt.endIdx + 1);
        i = bt.endIdx;
        continue;
      }
      if (ch === "$" && next === "(") {
        const sub = scanCommandSubst(commandLine, i);
        current += commandLine.slice(i, sub.endIdx + 1);
        i = sub.endIdx;
        continue;
      }
      current += ch;
      if (ch === '"') inDouble = false;
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
      const bt = scanBacktick(commandLine, i);
      current += commandLine.slice(i, bt.endIdx + 1);
      i = bt.endIdx;
      continue;
    }
    if (ch === "$" && next === "(") {
      const sub = scanCommandSubst(commandLine, i);
      current += commandLine.slice(i, sub.endIdx + 1);
      i = sub.endIdx;
      continue;
    }
    if (ch === "(" && (current.trim() === "" || current.trim().endsWith("("))) {
      const grp = scanBalancedGroup(commandLine, i, "(", ")");
      if (grp.closed) {
        current += commandLine.slice(i, grp.endIdx + 1);
        i = grp.endIdx;
        continue;
      }
    }
    if (
      ch === "{" &&
      (current.trim() === "" || /\(\s*\)$/.test(current.trim())) &&
      typeof next === "string" &&
      /[\s;\n]/.test(next)
    ) {
      const grp = scanBalancedGroup(commandLine, i, "{", "}");
      if (grp.closed) {
        current += commandLine.slice(i, grp.endIdx + 1);
        i = grp.endIdx;
        continue;
      }
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
      const bt = scanBacktick(segment, i);
      if (bt.body.trim()) inner.push(bt.body);
      i = bt.endIdx;
      continue;
    }
    if (ch === "$" && segment[i + 1] === "(") {
      const sub = scanCommandSubst(segment, i);
      if (sub.body.trim()) inner.push(sub.body);
      i = sub.endIdx;
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

function isOutsideRel(rel) {
  return rel === ".." || rel.startsWith("../") || path.posix.isAbsolute(rel);
}

function resolvePhysicalPath(absTarget) {
  let current = path.resolve(absTarget);
  for (let hops = 0; hops < 24; hops += 1) {
    let cursor = current;
    const suffix = [];
    let foundSymlink = false;
    while (true) {
      let st;
      try {
        st = fs.lstatSync(cursor);
      } catch (err) {
        if (err && err.code === "ENOENT") {
          const parent = path.dirname(cursor);
          if (parent === cursor) {
            return {
              path: toPosix(path.resolve(cursor, ...suffix.reverse())),
              loop: false,
            };
          }
          suffix.push(path.basename(cursor));
          cursor = parent;
          continue;
        }
        return { path: toPosix(current), loop: false };
      }
      if (st.isSymbolicLink()) {
        let linkTarget;
        try {
          linkTarget = fs.readlinkSync(cursor);
        } catch {
          return { path: toPosix(current), loop: false };
        }
        const resolvedNext = path.resolve(path.dirname(cursor), linkTarget);
        current =
          suffix.length > 0
            ? path.resolve(resolvedNext, ...suffix.reverse())
            : resolvedNext;
        foundSymlink = true;
        break;
      }
      try {
        const realCursor = fs.realpathSync(cursor);
        const finalPath =
          suffix.length > 0
            ? path.resolve(realCursor, ...suffix.reverse())
            : realCursor;
        return { path: toPosix(finalPath), loop: false };
      } catch {
        return { path: toPosix(current), loop: false };
      }
    }
    if (!foundSymlink) break;
  }
  return { path: toPosix(current), loop: true };
}

function expandPwdPrefix(posixRaw) {
  if (posixRaw === "$PWD" || posixRaw === "${PWD}") return ".";
  if (posixRaw.startsWith("$PWD/")) return `./${posixRaw.slice(5)}`;
  if (posixRaw.startsWith("${PWD}/")) return `./${posixRaw.slice(7)}`;
  return posixRaw;
}

function isHomePath(val) {
  return (
    val === "~" ||
    val.startsWith("~/") ||
    val.startsWith("$HOME") ||
    val.startsWith("${HOME}")
  );
}

/**
 * Resolve a target path against `root` / `cwd` and report whether it escapes `root`.
 */
export function relativeToRoot(rawPath, root, cwd) {
  const cleaned = unquoteShellToken(String(rawPath || "")).trim();
  const posixRaw = expandPwdPrefix(toPosix(cleaned));
  if (!posixRaw || isHomePath(posixRaw)) {
    return { outside: true, symlinkEscape: false, rel: null, normalized: posixRaw };
  }

  const cwdPosix = cwd ? toPosix(cwd) : "";
  if (cwdPosix && isHomePath(cwdPosix) && !posixRaw.startsWith("/")) {
    return { outside: true, symlinkEscape: false, rel: null, normalized: posixRaw };
  }

  const absRoot = path.posix.resolve(toPosix(root || "/"));
  const baseDir = cwdPosix
    ? path.posix.resolve(absRoot, cwdPosix)
    : absRoot;
  const resolved = path.posix.resolve(baseDir, posixRaw);

  let rootExists = false;
  try {
    rootExists = fs.existsSync(absRoot);
  } catch {
    rootExists = false;
  }

  if (rootExists) {
    let realRoot = absRoot;
    try {
      realRoot = toPosix(fs.realpathSync(absRoot));
    } catch {
      realRoot = absRoot;
    }
    const lexRelAbs = path.posix.relative(absRoot, resolved);
    const lexRelReal = path.posix.relative(realRoot, resolved);
    const lexicalOutside = isOutsideRel(lexRelAbs) && isOutsideRel(lexRelReal);

    const phys = resolvePhysicalPath(resolved);
    if (phys.loop && !lexicalOutside) {
      return {
        outside: false,
        symlinkEscape: true,
        rel: isOutsideRel(lexRelAbs) ? lexRelReal : lexRelAbs,
        normalized: phys.path,
      };
    }

    const physRel = path.posix.relative(realRoot, phys.path);
    const physOutside = isOutsideRel(physRel);

    if (!lexicalOutside && physOutside) {
      return {
        outside: false,
        symlinkEscape: true,
        rel: isOutsideRel(lexRelAbs) ? lexRelReal : lexRelAbs,
        normalized: phys.path,
      };
    }

    return {
      outside: physOutside,
      symlinkEscape: false,
      rel: physOutside ? null : physRel === "" ? "." : physRel,
      normalized: phys.path,
    };
  }

  const rel = path.posix.relative(absRoot, resolved);
  const outside = isOutsideRel(rel);

  return {
    outside,
    symlinkEscape: false,
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

const CASE_INSENSITIVE_FS =
  process.platform === "darwin" || process.platform === "win32";

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
  let checkPath = path.posix.normalize(expandPwdPrefix(toPosix(unquoted)));
  if (checkPath.length > 1 && checkPath.endsWith("/")) {
    checkPath = checkPath.slice(0, -1);
  }

  let rel = null;
  let outside = false;
  if (root) {
    const info = relativeToRoot(unquoted, root, cwd);
    if (info.symlinkEscape) {
      return {
        decision: "deny",
        reason: `Blocked symlink target escaping workspace (${unquoted}).`,
        rel: info.rel,
      };
    }
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
  const lowerCheck = normalizedCheck.toLowerCase();
  if (
    lowerCheck === ".git" ||
    lowerCheck.startsWith(".git/") ||
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
    const bareLower = bare.toLowerCase();
    const prefixLower = prefix.toLowerCase();
    if (
      lowerCheck === bareLower ||
      lowerCheck.startsWith(prefixLower) ||
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
    const candidateLower = candidateRel.toLowerCase();
    for (const frozenPath of policy.frozenSet) {
      const cleanFrozen = frozenPath.replace(/\/+$/, "");
      const cleanFrozenLower = cleanFrozen.toLowerCase();
      if (
        candidateRel === cleanFrozen ||
        (cleanFrozen && candidateRel.startsWith(`${cleanFrozen}/`)) ||
        (CASE_INSENSITIVE_FS &&
          (candidateLower === cleanFrozenLower ||
            (cleanFrozenLower && candidateLower.startsWith(`${cleanFrozenLower}/`))))
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

function findUnquotedRedirect(rawToken) {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < rawToken.length; i += 1) {
    const ch = rawToken[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === "\\" && i + 1 < rawToken.length) {
      i += 1;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }

    if (ch === ">" || (ch === "&" && rawToken[i + 1] === ">") || (ch === "<" && rawToken[i + 1] === ">")) {
      let opStart = i;
      const prefix = rawToken.slice(0, i);
      if (/^\d+$/.test(prefix)) {
        opStart = 0;
      }
      const rest = rawToken.slice(i);
      const opMatch = rest.match(/^(?:&>>|&>|>>|>\||<>|>&|>)/);
      if (opMatch) {
        const op = opMatch[0];
        const opEnd = i + op.length;
        return {
          opStart,
          op,
          prefix: rawToken.slice(0, opStart),
          suffix: rawToken.slice(opEnd),
        };
      }
    }
  }
  return null;
}

function isFdTarget(op, target) {
  if (/^&\d+$|^&-$/.test(target)) return true;
  if (op.endsWith(">&") && /^(?:\d+|-)$/.test(target)) return true;
  return false;
}

function extractRedirects(rawTokens) {
  const redirectTargets = [];
  const commandTokens = [];

  for (let i = 0; i < rawTokens.length; i += 1) {
    const raw = rawTokens[i];
    const tok = unquoteShellToken(raw);

    if (/^(?:\d+|&)?(?:>>?|>\||<>|>&|&>>?)$/.test(tok)) {
      if (i + 1 < rawTokens.length) {
        const nextTok = unquoteShellToken(rawTokens[i + 1]);
        if (!isFdTarget(tok, nextTok)) redirectTargets.push(nextTok);
        i += 1;
      }
      continue;
    }

    const found = findUnquotedRedirect(raw);
    if (found) {
      if (found.prefix) {
        commandTokens.push(found.prefix);
      }
      if (found.suffix) {
        const target = unquoteShellToken(found.suffix);
        if (!isFdTarget(found.op, target)) redirectTargets.push(target);
      } else if (i + 1 < rawTokens.length) {
        const nextTok = unquoteShellToken(rawTokens[i + 1]);
        if (!isFdTarget(found.op, nextTok)) redirectTargets.push(nextTok);
        i += 1;
      }
      continue;
    }

    commandTokens.push(raw);
  }

  return { redirectTargets, commandTokens };
}

function parseCopyMoveDestinations(
  args,
  { includeSources = false, extraValueFlags = [] } = {},
) {
  let targetDir = null;
  const positional = [];
  let stopFlags = false;
  const valueFlags = new Set([
    "-t",
    "--target-directory",
    "-S",
    "--suffix",
    ...extraValueFlags,
  ]);

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
    if (!stopFlags && /^-[A-Za-z]*t$/.test(tok)) {
      const next = i + 1 < args.length ? unquoteShellToken(args[i + 1]) : null;
      if (next) targetDir = next;
      i += 1;
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
    return { targets: out, positional, targetDir };
  }
  const targets = targetDir
    ? [targetDir]
    : positional.length >= 2
      ? [positional[positional.length - 1]]
      : positional.length === 1 && targetDir === null
        ? [positional[0]]
        : [];
  return { targets, positional, targetDir };
}

function parseInPlaceTargets(cmd, args) {
  let inPlace = false;
  let hasExplicitScript = false;
  let expectBackupExt = false;
  const positional = [];
  let stopFlags = false;

  for (let i = 0; i < args.length; i += 1) {
    const tok = unquoteShellToken(args[i]);
    if (!stopFlags && expectBackupExt) {
      expectBackupExt = false;
      if (tok === "") {
        continue;
      }
    }
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
        if (tok === "-i" || /^-[A-Za-z]*i$/.test(tok)) {
          expectBackupExt = true;
        }
      }
      if (tok === "-e" || tok === "-f" || tok === "--expression" || tok === "--file") {
        hasExplicitScript = true;
        i += 1;
      } else if (
        tok.startsWith("--expression=") ||
        tok.startsWith("--file=") ||
        (!tok.startsWith("--") && /^-[A-Za-z]*[ef]$/.test(tok))
      ) {
        hasExplicitScript = true;
        if (!tok.startsWith("--")) i += 1;
      } else if (!tok.startsWith("--") && /^-[A-Za-z]*[ef].+$/.test(tok)) {
        hasExplicitScript = true;
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

function hasShortFlag(tokens, flagChar, valueFlags = new Set()) {
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === "--") break;
    if (valueFlags.has(tok)) {
      i += 1;
      continue;
    }
    if (tok.startsWith("-") && !tok.startsWith("--") && tok.length > 1) {
      if (tok.slice(1).includes(flagChar)) return true;
    }
  }
  return false;
}

function resolveCdTarget(rawTarget, root, currentCwd) {
  const cleaned = unquoteShellToken(String(rawTarget || "")).trim();
  if (!cleaned || isHomePath(cleaned)) {
    return "~";
  }
  const absRoot = path.posix.resolve(toPosix(root || "/"));
  const baseDir =
    currentCwd && !isHomePath(toPosix(currentCwd))
      ? path.posix.resolve(absRoot, toPosix(currentCwd))
      : absRoot;
  return path.posix.resolve(baseDir, expandPwdPrefix(toPosix(cleaned)));
}

function splitWrappedGroup(segment) {
  const trimmed = segment.trim();
  if (trimmed.startsWith("(") && !trimmed.startsWith("((")) {
    const grp = scanBalancedGroup(trimmed, 0, "(", ")");
    if (grp.closed) {
      return {
        kind: "subshell",
        inner: trimmed.slice(1, grp.endIdx),
        suffix: trimmed.slice(grp.endIdx + 1).trim(),
      };
    }
  }
  if (trimmed.startsWith("{") && /^\{[\s;\n]/.test(trimmed)) {
    const grp = scanBalancedGroup(trimmed, 0, "{", "}");
    if (grp.closed) {
      return {
        kind: "brace",
        inner: trimmed.slice(1, grp.endIdx),
        suffix: trimmed.slice(grp.endIdx + 1).trim(),
      };
    }
  }
  return null;
}

const SHELL_WRAPPER_VALUE_FLAGS = new Set(["-o", "+o", "-O", "+O"]);
const GIT_COMMIT_VALUE_FLAGS = new Set([
  "-m",
  "--message",
  "-F",
  "--file",
  "-C",
  "--reuse-message",
  "-c",
  "--reedit-message",
  "--author",
  "--date",
  "--cleanup",
  "-S",
  "--gpg-sign",
]);
const GIT_CHECKOUT_VALUE_FLAGS = new Set([
  "-b",
  "-B",
  "--orphan",
  "--conflict",
  "-U",
  "--unified",
  "--pathspec-from-file",
]);

function evaluateShellInternal(
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
    return { decision: "allow", finalCwd: cwd };
  }
  if (depth > 5) {
    return {
      decision: "deny",
      reason: "Blocked excessively nested shell command expansion.",
      finalCwd: cwd,
    };
  }

  if (/:\(\)\s*\{[^}]*:\s*\|\s*:[^}]*\}\s*;\s*:/.test(commandLine)) {
    return {
      decision: "deny",
      reason: "Blocked catastrophic shell fork bomb.",
      finalCwd: cwd,
    };
  }

  let currentCwd = cwd || root;
  let prevCwd = currentCwd;

  const subOpts = (activeCwd) => ({
    root,
    cwd: activeCwd,
    ctx,
    respectOutside,
    gitPushDecision,
    gitPushForceDecision,
    gitAskDecision,
    sliceCheck,
    depth: depth + 1,
  });

  const checkPath = (rawTarget, { targetCwd = currentCwd, checkSlice = true } = {}) => {
    const res = inspectTargetPath(rawTarget, {
      root,
      cwd: targetCwd,
      ctx,
      respectOutside,
    });
    if (res.decision !== "allow") return res;
    if (checkSlice && sliceCheck && !res.outside) {
      const sliceRes = sliceCheck(res.rel ?? rawTarget, targetCwd);
      if (sliceRes && sliceRes.decision !== "allow") return sliceRes;
    }
    return { decision: "allow", rel: res.rel, outside: res.outside };
  };

  let pendingAsk = null;
  const recordAsk = (reason) => {
    if (!pendingAsk) pendingAsk = { decision: gitAskDecision, reason };
  };

  const pipelines = splitShellPipelines(commandLine);

  for (const pipeline of pipelines) {
    let sawDownloader = false;
    const isPipe = pipeline.length > 1;

    for (const segment of pipeline) {
      const segCwd = currentCwd;

      for (const inner of extractCommandSubstitutions(segment)) {
        const subRes = evaluateShellInternal(inner, subOpts(segCwd));
        if (subRes.decision === "deny") return subRes;
        if (subRes.decision !== "allow") recordAsk(subRes.reason);
      }

      const wrapped = splitWrappedGroup(segment);
      if (wrapped) {
        if (wrapped.suffix) {
          const suffixTokens = tokenizeShellSegment(wrapped.suffix);
          const { redirectTargets } = extractRedirects(suffixTokens);
          for (const target of redirectTargets) {
            const targetRes = checkPath(target, { targetCwd: segCwd });
            if (targetRes.decision !== "allow") return targetRes;
          }
        }
        const nestedRes = evaluateShellInternal(wrapped.inner, subOpts(segCwd));
        if (nestedRes.decision === "deny") return nestedRes;
        if (nestedRes.decision !== "allow") recordAsk(nestedRes.reason);
        if (wrapped.kind === "brace" && !isPipe && nestedRes.finalCwd !== undefined) {
          currentCwd = nestedRes.finalCwd;
        }
        continue;
      }

      const rawTokens = tokenizeShellSegment(segment);
      if (rawTokens.length === 0) continue;

      const { redirectTargets, commandTokens } = extractRedirects(rawTokens);
      for (const target of redirectTargets) {
        const targetRes = checkPath(target, { targetCwd: segCwd });
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

      if (cmd === "cd" || cmd === "pushd") {
        let dirArg = "";
        for (const arg of unquotedArgs) {
          if (arg === "--" || /^-[LPe@]+$/.test(arg)) continue;
          dirArg = arg;
          break;
        }
        if (!isPipe) {
          if (dirArg === "-") {
            const tmp = currentCwd;
            currentCwd = prevCwd;
            prevCwd = tmp;
          } else {
            prevCwd = currentCwd;
            currentCwd = resolveCdTarget(dirArg, root, currentCwd);
          }
        }
        continue;
      }

      if (cmd === "mkfs" || cmd.startsWith("mkfs.")) {
        return {
          decision: "deny",
          reason: "Blocked catastrophic filesystem formatting command (mkfs).",
        };
      }

      if (cmd === "eval") {
        const evalArgs = unquotedArgs[0] === "--" ? unquotedArgs.slice(1) : unquotedArgs;
        const joined = evalArgs.join(" ").trim();
        if (joined) {
          const nestedRes = evaluateShellInternal(joined, subOpts(segCwd));
          if (nestedRes.decision === "deny") return nestedRes;
          if (nestedRes.decision !== "allow") recordAsk(nestedRes.reason);
          if (!isPipe && nestedRes.finalCwd !== undefined) {
            currentCwd = nestedRes.finalCwd;
          }
        }
        continue;
      }

      if (SHELL_WRAPPER_CMDS.has(cmd)) {
        for (let i = 0; i < unquotedArgs.length; i += 1) {
          const arg = unquotedArgs[i];
          if (arg === "--") break;
          if (SHELL_WRAPPER_VALUE_FLAGS.has(arg)) {
            i += 1;
            continue;
          }
          if (arg === "-c" || /^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) {
            let cmdIdx = i + 1;
            if (unquotedArgs[cmdIdx] === "--") cmdIdx += 1;
            if (cmdIdx < unquotedArgs.length) {
              const nestedRes = evaluateShellInternal(unquotedArgs[cmdIdx], subOpts(segCwd));
              if (nestedRes.decision === "deny") return nestedRes;
              if (nestedRes.decision !== "allow") recordAsk(nestedRes.reason);
            }
            break;
          }
          if (!arg.startsWith("-") && !arg.startsWith("+")) break;
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
            isCatastrophicRm(target, segCwd)
          ) {
            return {
              decision: "deny",
              reason: `Blocked catastrophic recursive delete targeting "${target}".`,
            };
          }
          const targetRes = checkPath(target, { targetCwd: segCwd });
          if (targetRes.decision !== "allow") return targetRes;
        }
        continue;
      }

      if (cmd === "mv") {
        const parsed = parseCopyMoveDestinations(args, { includeSources: true });
        for (const target of parsed.targets) {
          const res = checkPath(target, { targetCwd: segCwd });
          if (res.decision !== "allow") return res;
        }
        continue;
      }

      if (cmd === "cp" || cmd === "ln" || cmd === "install") {
        const extraValueFlags =
          cmd === "install"
            ? ["-m", "--mode", "-o", "--owner", "-g", "--group"]
            : [];
        const parsed = parseCopyMoveDestinations(args, {
          includeSources: false,
          extraValueFlags,
        });
        for (const target of parsed.targets) {
          const res = checkPath(target, { targetCwd: segCwd });
          if (res.decision !== "allow") return res;
        }
        if (
          cmd === "ln" &&
          (hasShortFlag(unquotedArgs, "s") || unquotedArgs.includes("--symbolic")) &&
          parsed.targets.length > 0 &&
          parsed.positional.length >= (parsed.targetDir ? 1 : 2)
        ) {
          const linkTarget = parsed.positional[0];
          const destLink = parsed.targets[0];
          const destInfo = root ? relativeToRoot(destLink, root, segCwd) : null;
          if (destInfo && !destInfo.outside) {
            const absRoot = path.posix.resolve(toPosix(root));
            const baseDir = segCwd
              ? path.posix.resolve(absRoot, toPosix(segCwd))
              : absRoot;
            const resolvedDest = path.posix.resolve(baseDir, toPosix(destLink));
            const linkDir = parsed.targetDir ? resolvedDest : path.posix.dirname(resolvedDest);
            const targetInfo = relativeToRoot(linkTarget, root, linkDir);
            if (targetInfo.outside || targetInfo.symlinkEscape) {
              return {
                decision: "deny",
                reason: `Blocked symlink escaping workspace (${linkTarget} -> ${destLink}).`,
              };
            }
            const targetRes = checkPath(linkTarget, { targetCwd: linkDir });
            if (targetRes.decision !== "allow") return targetRes;
          } else if (!root) {
            const targetRes = checkPath(linkTarget, { targetCwd: segCwd });
            if (targetRes.decision !== "allow") return targetRes;
          }
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
          const res = checkPath(arg, { targetCwd: segCwd });
          if (res.decision !== "allow") return res;
        }
        continue;
      }

      if (cmd === "sed" || cmd === "perl") {
        for (const target of parseInPlaceTargets(cmd, args)) {
          const res = checkPath(target, { targetCwd: segCwd });
          if (res.decision !== "allow") return res;
        }
        continue;
      }

      if (cmd === "dd") {
        for (const arg of unquotedArgs) {
          if (arg.startsWith("of=")) {
            const res = checkPath(arg.slice(3), { targetCwd: segCwd });
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
          subcommand === "config" &&
          !subArgs.some((a) =>
            ["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(a),
          ) &&
          subArgs.some((a) => /^core\.hooksPath(?:=|$)/i.test(a))
        ) {
          return {
            decision: "deny",
            reason: "Blocked hook bypass via git config core.hooksPath.",
          };
        }
        if (
          subArgs.includes("--no-verify") ||
          (NO_VERIFY_GIT_SUBCOMMANDS.has(subcommand) &&
            (subcommand === "commit" || subcommand === "merge") &&
            hasShortFlag(subArgs, "n", GIT_COMMIT_VALUE_FLAGS))
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
          let pathSpecs = [];
          if (dashIdx >= 0) {
            pathSpecs = subArgs.slice(dashIdx + 1);
          } else if (subcommand === "restore") {
            pathSpecs = subArgs.filter((a, idx) => {
              if (a.startsWith("-")) return false;
              const prev = idx > 0 ? subArgs[idx - 1] : "";
              return prev !== "-s" && prev !== "--source" && prev !== "--conflict";
            });
          } else {
            for (let j = 0; j < subArgs.length; j += 1) {
              const tok = subArgs[j];
              if (GIT_CHECKOUT_VALUE_FLAGS.has(tok)) {
                j += 1;
                continue;
              }
              if (tok.startsWith("-")) continue;
              pathSpecs.push(tok);
            }
          }
          for (const target of pathSpecs) {
            let checkSliceForTarget = dashIdx >= 0 || subcommand === "restore";
            if (!checkSliceForTarget && root && segCwd) {
              try {
                const absRoot = path.posix.resolve(toPosix(root));
                const baseDir = path.posix.resolve(absRoot, toPosix(segCwd));
                if (fs.existsSync(path.resolve(baseDir, target))) {
                  checkSliceForTarget = true;
                }
              } catch {
                checkSliceForTarget = false;
              }
            }
            const res = checkPath(target, {
              targetCwd: segCwd,
              checkSlice: checkSliceForTarget,
            });
            if (res.decision !== "allow") return res;
          }
        }
      }
    }
  }

  return pendingAsk
    ? { ...pendingAsk, finalCwd: currentCwd }
    : { decision: "allow", finalCwd: currentCwd };
}

/**
 * Evaluate a single shell command line against CONTRACT.md §8 rules and optional slice checks.
 */
export function evaluateShellCommand(commandLine, options = {}) {
  const result = evaluateShellInternal(commandLine, options);
  if (!result || typeof result !== "object") return { decision: "allow" };
  const { finalCwd: _ignored, ...clean } = result;
  return clean;
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
