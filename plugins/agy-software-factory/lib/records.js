import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function readRecord(cwd, name) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(cwd, ".factory", name), "utf8"),
    );
  } catch {
    return null;
  }
}
export function factoryDirectory(cwd) {
  const dir = path.join(fs.realpathSync(cwd), ".factory");
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink())
    throw new Error("Refusing symlink .factory directory");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
export function writeRecord(cwd, name, record) {
  if (path.basename(name) !== name) throw new Error("Invalid record name");
  const dir = factoryDirectory(cwd),
    target = path.join(dir, name),
    tmp = path.join(dir, `.${name}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
