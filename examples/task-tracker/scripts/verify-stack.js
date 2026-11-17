import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = `factory-${crypto.randomUUID().slice(0, 12)}`;
const artifacts = path.join(root, ".factory", project);
fs.mkdirSync(artifacts, { recursive: true });
const env = {
  ...process.env,
  TEST_DB_PASSWORD: crypto.randomBytes(24).toString("hex"),
  FACTORY_ARTIFACT_DIR: artifacts,
};
delete env.NODE_TEST_CONTEXT;
let sequence = 0;
async function command(
  bin,
  args,
  { cwd = root, timeout = 600000, capture = false } = {},
) {
  const logfile = path.join(
      artifacts,
      `${++sequence}-${path.basename(bin)}.log`,
    ),
    fd = fs.openSync(logfile, "w");
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: ["ignore", capture ? "pipe" : fd, fd],
    });
    let data = "",
      timedOut = false;
    child.stdout?.on("data", (b) => {
      data += b;
      if (data.length > 1000000) child.kill("SIGTERM");
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.on("error", (e) => {
      clearTimeout(timer);
      fs.closeSync(fd);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        fs.closeSync(fd);
      } catch {}
      if (code === 0 && !timedOut) resolve(data.trim());
      else {
        const text = fs.existsSync(logfile)
          ? fs.readFileSync(logfile, "utf8")
          : "Log file unavailable";
        reject(
          new Error(
            `${bin} ${args[0]} failed (${timedOut ? "timeout" : code}). ${text.slice(-3000)}\nLogs: ${artifacts}`,
          ),
        );
      }
    });
  });
}
const compose = ["compose", "-p", project, "-f", "compose.acceptance.yml"];
const runCompose = (...args) => command("docker", [...compose, ...args]);
async function ready(url) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Service not ready: ${url}`);
}
let started = false;
try {
  await command("docker", ["compose", "version"], { timeout: 10000 });
  started = true;
  await runCompose("up", "--build", "-d");
  const endpoint = async (service, port) =>
    `http://${await command("docker", [...compose, "port", service, String(port)], { capture: true, timeout: 10000 })}`;
  env.API_BASE_URL = await endpoint("api", 4000);
  env.WEB_BASE_URL = await endpoint("web", 80);
  const dbAddress = await command(
    "docker",
    [...compose, "port", "db", "5432"],
    { capture: true, timeout: 10000 },
  );
  env.DATABASE_URL = `postgres://tasks_user:${env.TEST_DB_PASSWORD}@${dbAddress}/tasks_db`;
  await ready(`${env.API_BASE_URL}/health`);
  await ready(`${env.WEB_BASE_URL}/health`);
  await command(process.execPath, ["--test", "tests/integration.test.js"], {
    cwd: path.join(root, "api"),
    timeout: 60000,
  });
  await command(
    process.execPath,
    ["node_modules/@playwright/test/cli.js", "test"],
    { cwd: path.join(root, "web"), timeout: 120000 },
  );
  // Prove the real stack's health signal fails when PostgreSQL goes away.
  await runCompose("stop", "db");
  const unavailable = await fetch(`${env.API_BASE_URL}/health`, {
    signal: AbortSignal.timeout(10000),
  });
  if (unavailable.status !== 500)
    throw new Error(
      "API must stay alive and return 500 when database is unavailable",
    );
  console.log(
    `Live PostgreSQL integration and browser acceptance PASS. Artifacts: ${artifacts}`,
  );
} catch (error) {
  console.error(error.message.replaceAll(env.TEST_DB_PASSWORD, "[redacted]"));
  process.exitCode = 1;
} finally {
  if (started)
    try {
      await runCompose("down", "--volumes", "--remove-orphans");
    } catch (error) {
      console.error(
        `Cleanup failed for ${project}: ${error.message.replaceAll(env.TEST_DB_PASSWORD, "[redacted]")}`,
      );
      process.exitCode = 1;
    }
}
