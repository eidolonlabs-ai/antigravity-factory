import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
const archive = path.resolve(process.argv[2] || "");
if (!fs.statSync(archive).isFile()) throw new Error("Supply a release archive");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "factory isolated ")),
  bundle = path.join(temp, "antigravity-factory"),
  project = path.join(temp, "project");
function modes(dir, readonly) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) modes(p, readonly);
    fs.chmodSync(
      p,
      e.isDirectory() ? (readonly ? 0o555 : 0o755) : readonly ? 0o444 : 0o644,
    );
  }
  fs.chmodSync(dir, readonly ? 0o555 : 0o755);
}
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
try {
  const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .trim()
    .split("\n");
  if (
    entries.some(
      (n) =>
        !n.startsWith("antigravity-factory/") || n.split("/").includes(".."),
    )
  )
    throw new Error("Unsafe archive paths");
  execFileSync("tar", ["-xzf", archive, "-C", temp]);
  modes(bundle, true);
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, ".gitignore"), ".env\n.factory/\n");
  fs.writeFileSync(
    path.join(project, "package.json"),
    JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
  );
  const cli = path.join(bundle, "bin/agy-factory.js");
  execFileSync(process.execPath, [cli, "init", project, "--mode", "copy"], {
    cwd: project,
    env,
    stdio: "pipe",
  });
  execFileSync(process.execPath, [cli, "verify", "--cwd", project], {
    cwd: project,
    env,
    stdio: "pipe",
  });
  execFileSync(process.execPath, [cli, "status", "--cwd", project, "--json"], {
    cwd: project,
    env,
    stdio: "pipe",
  });
  for (const hook of ["pre-tool-guard", "stop-verify-gate"]) {
    const r = spawnSync(
      process.execPath,
      [path.join(bundle, "bin", `${hook}.js`)],
      {
        cwd: bundle,
        env,
        input: JSON.stringify({
          workspacePaths: [project],
          fullyIdle: true,
          terminationReason: "model_stop",
        }),
        encoding: "utf8",
      },
    );
    if (r.status !== 0 || JSON.parse(r.stdout).decision !== "allow")
      throw new Error(`Hook smoke failed: ${hook}`);
  }
  if (process.argv.includes("--native"))
    execFileSync("agy", ["plugin", "validate", bundle, "--strict", "--json"], {
      stdio: "inherit",
    });
  console.log(
    "Extracted read-only plugin CLI, copy installation and hook smoke passed",
  );
} finally {
  if (fs.existsSync(temp)) modes(temp, false);
  fs.rmSync(temp, { recursive: true, force: true });
}
