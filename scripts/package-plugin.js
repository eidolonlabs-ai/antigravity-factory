import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "plugins/antigravity-factory");
const manifest = JSON.parse(fs.readFileSync(path.join(source, "plugin.json")));
if (!/^\d+\.\d+\.\d+$/.test(manifest.version))
  throw new Error("Release requires a semantic version");
if (
  JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version !==
  manifest.version
)
  throw new Error("Root and plugin versions differ");
const out = path.resolve(
  process.argv[process.argv.indexOf("--out") + 1] &&
    process.argv.includes("--out")
    ? process.argv[process.argv.indexOf("--out") + 1]
    : path.join(root, "dist"),
);
fs.mkdirSync(out, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "factory-package-")),
  bundle = path.join(temp, "antigravity-factory");
fs.mkdirSync(bundle);
const files = {};
function copy(src, dest) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink())
    throw new Error(`Bundle symlink not allowed: ${src}`);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const n of fs.readdirSync(src).sort())
      copy(path.join(src, n), path.join(dest, n));
  } else {
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o644);
    files[path.relative(bundle, dest).split(path.sep).join("/")] = crypto
      .createHash("sha256")
      .update(fs.readFileSync(dest))
      .digest("hex");
  }
}
try {
  for (const name of [
    "plugin.json",
    "package.json",
    "README.md",
    "LICENSE",
    "hooks.json",
    "assets",
    "bin",
    "lib",
    "rules",
    "roles",
    "agents",
    "skills",
  ])
    copy(path.join(source, name), path.join(bundle, name));
  const archive = path.join(
    out,
    `antigravity-factory-${manifest.version}.tgz`,
  );
  execFileSync("tar", ["-czf", archive, "-C", temp, "antigravity-factory"], {
    stdio: "pipe",
  });
  fs.writeFileSync(
    path.join(out, `antigravity-factory-${manifest.version}.sha256.json`),
    JSON.stringify(
      {
        schemaVersion: 1,
        version: manifest.version,
        archive: path.basename(archive),
        sha256: crypto
          .createHash("sha256")
          .update(fs.readFileSync(archive))
          .digest("hex"),
        files,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(archive);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
