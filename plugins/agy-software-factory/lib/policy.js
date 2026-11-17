import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const hash = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid policy ${name}: expected object`);
  return value;
}
function keys(value, allowed, name) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new Error(`Unknown policy ${name}.${key}`);
}
export function within(root, target) {
  const rel = path.relative(root, target);
  return (
    rel === "" ||
    (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`))
  );
}
export function loadFactoryPolicy(cwd = process.cwd()) {
  const root = fs.realpathSync(cwd),
    file = path.join(root, ".factory.json");
  let raw = {};
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`Invalid policy .factory.json: ${e.message}`);
    }
  }
  object(raw, "root");
  keys(
    raw,
    [
      "schemaVersion",
      "requireTests",
      "enforceStopVerify",
      "verification",
      "stop",
    ],
    "root",
  );
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1)
    throw new Error("Unsupported policy schemaVersion");
  for (const k of ["requireTests", "enforceStopVerify"])
    if (raw[k] !== undefined && typeof raw[k] !== "boolean")
      throw new Error(`Invalid policy ${k}`);
  const v = object(raw.verification ?? {}, "verification");
  keys(
    v,
    ["requiredChecks", "commands", "requiredEvidence", "artifactRoots"],
    "verification",
  );
  for (const k of [
    "requiredChecks",
    "commands",
    "requiredEvidence",
    "artifactRoots",
  ])
    if (v[k] !== undefined && !Array.isArray(v[k]))
      throw new Error(`Invalid policy verification.${k}`);
  const requiredChecks = (v.requiredChecks ?? []).map((s) => {
    object(s, "required check");
    keys(s, ["component", "category"], "check");
    if (
      typeof s.component !== "string" ||
      !s.component ||
      path.isAbsolute(s.component) ||
      s.component.split("/").includes("..") ||
      s.component.includes("\\") ||
      !["lint", "typecheck", "test", "build"].includes(s.category)
    )
      throw new Error("Invalid policy required check");
    return {
      component:
        s.component === "."
          ? "."
          : s.component.replace(/^\.\//, "").replace(/\/$/, ""),
      category: s.category,
    };
  });
  const ids = new Set();
  const commands = (v.commands ?? []).map((c) => {
    object(c, "command");
    keys(
      c,
      ["id", "cwd", "command", "timeoutMs", "providesEvidence"],
      "command",
    );
    if (
      typeof c.id !== "string" ||
      !/^[a-z][a-z0-9-]*$/.test(c.id) ||
      ids.has(c.id)
    )
      throw new Error("Invalid or duplicate command id");
    ids.add(c.id);
    if (
      typeof c.command !== "string" ||
      !c.command.trim() ||
      typeof (c.cwd ?? ".") !== "string"
    )
      throw new Error("Invalid policy command");
    const dir = fs.realpathSync(path.resolve(root, c.cwd ?? "."));
    if (!within(root, dir) || !fs.statSync(dir).isDirectory())
      throw new Error("Command cwd must remain within workspace");
    const timeoutMs = c.timeoutMs ?? 120000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1800000)
      throw new Error("Command timeoutMs must be 1000–1800000");
    if (c.providesEvidence !== undefined && c.providesEvidence !== "browser")
      throw new Error("Command providesEvidence must be browser");
    return { ...c, cwd: path.relative(root, dir) || ".", timeoutMs };
  });
  const requiredEvidence = [...new Set(v.requiredEvidence ?? [])];
  if (requiredEvidence.some((k) => !["browser", "review"].includes(k)))
    throw new Error("Invalid requiredEvidence kind");
  const artifactRoots = (v.artifactRoots ?? []).map((p) => {
    if (
      typeof p !== "string" ||
      !path.isAbsolute(p) ||
      !fs.statSync(p).isDirectory()
    )
      throw new Error("Artifact roots must be existing absolute directories");
    return fs.realpathSync(p);
  });
  const stop = object(raw.stop ?? {}, "stop");
  keys(stop, ["mode", "maxContinuations"], "stop");
  const mode = stop.mode ?? (raw.enforceStopVerify ? "remind" : "off"),
    maxContinuations = stop.maxContinuations ?? 1;
  if (
    !["off", "remind"].includes(mode) ||
    !Number.isInteger(maxContinuations) ||
    maxContinuations < 0 ||
    maxContinuations > 3
  )
    throw new Error("Invalid stop policy");
  const policy = {
    schemaVersion: 1,
    requireTests: raw.requireTests ?? false,
    verification: { requiredChecks, commands, requiredEvidence, artifactRoots },
    stop: { mode, maxContinuations },
  };
  // The slice contract is verification input even though runtime records are ignored.
  const specFile = [".factory/spec.json", "factory-spec.json"].find((p) =>
    fs.existsSync(path.join(root, p)),
  );
  return {
    ...policy,
    policyDigest: hash(
      canonical(policy) +
        (specFile ? fs.readFileSync(path.join(root, specFile), "utf8") : ""),
    ),
  };
}
