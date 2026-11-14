import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { evaluatePreToolUse } from '../plugins/agy-software-factory/bin/pre-tool-guard.js';
import { evaluateStop } from '../plugins/agy-software-factory/bin/stop-verify-gate.js';
import { runVerify } from '../plugins/agy-software-factory/lib/verify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PRE_TOOL_BIN = path.join(
  REPO_ROOT,
  'plugins',
  'agy-software-factory',
  'bin',
  'pre-tool-guard.js'
);
const STOP_GATE_BIN = path.join(
  REPO_ROOT,
  'plugins',
  'agy-software-factory',
  'bin',
  'stop-verify-gate.js'
);

function createDirtyGitRepo(t) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-hook-test-'));
  t.after(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'factory@example.com'], {
    cwd: repoDir,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.name', 'Factory Test'], {
    cwd: repoDir,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], {
    cwd: repoDir,
    stdio: 'ignore',
  });

  fs.writeFileSync(
    path.join(repoDir, '.gitignore'),
    'node_modules/\n.factory/\n.env\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(repoDir, 'package.json'),
    JSON.stringify(
      {
        name: 'hook-test-repo',
        version: '1.0.0',
        scripts: {
          test: 'node -e "process.exit(0)"',
        },
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
  fs.writeFileSync(path.join(repoDir, 'app.js'), 'export const value = 1;\n', 'utf8');

  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'initial commit'], {
    cwd: repoDir,
    stdio: 'ignore',
  });

  const appJsPath = path.join(repoDir, 'app.js');
  fs.writeFileSync(appJsPath, 'export const value = 2;\n', 'utf8');
  const past = new Date(Date.now() - 2000);
  fs.utimesSync(appJsPath, past, past);

  return repoDir;
}

function runHookProcess(scriptPath, payload, env = process.env) {
  const proc = spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env,
  });
  assert.equal(
    proc.status,
    0,
    `Expected hook process ${path.basename(scriptPath)} to exit 0, got ${proc.status}. stderr: ${proc.stderr}`
  );
  return JSON.parse(proc.stdout);
}

test('PreToolUse guard evaluates file writes and shell commands accurately', async () => {
  const denyEnv = await evaluatePreToolUse({
    toolCall: { name: 'write_file', args: { Path: '/repo/.env' } },
    workspacePaths: ['/repo'],
    conversationId: 'conv-pre-1',
    stepIdx: 1,
  });
  assert.equal(denyEnv.decision, 'deny');

  const allowEnvExample = await evaluatePreToolUse({
    toolCall: { name: 'write_file', args: { Path: '/repo/.env.example' } },
    workspacePaths: ['/repo'],
    conversationId: 'conv-pre-1',
    stepIdx: 2,
  });
  assert.equal(allowEnvExample.decision, 'allow');

  const denySshKey = await evaluatePreToolUse({
    toolCall: { name: 'edit_file', args: { Path: '/repo/keys/id_rsa' } },
    workspacePaths: ['/repo'],
    conversationId: 'conv-pre-1',
    stepIdx: 3,
  });
  assert.equal(denySshKey.decision, 'deny');

  const askGitReset = await evaluatePreToolUse({
    toolCall: { name: 'run_command', args: { CommandLine: 'git reset --hard HEAD~1' } },
    workspacePaths: ['/repo'],
    conversationId: 'conv-pre-1',
    stepIdx: 4,
  });
  assert.equal(askGitReset.decision, 'force_ask');

  const denyRmRoot = await evaluatePreToolUse({
    toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf /' } },
    workspacePaths: ['/repo'],
    conversationId: 'conv-pre-1',
    stepIdx: 5,
  });
  assert.equal(denyRmRoot.decision, 'deny');

  const allowNpmTest = await evaluatePreToolUse({
    toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } },
    workspacePaths: ['/repo'],
    conversationId: 'conv-pre-1',
    stepIdx: 6,
  });
  assert.equal(allowNpmTest.decision, 'allow');
});

test('PreToolUse guard script reads JSON from stdin and writes decision JSON to stdout', () => {
  const denied = runHookProcess(PRE_TOOL_BIN, {
    toolCall: { name: 'write_file', args: { Path: '/repo/.env' } },
    workspacePaths: ['/repo'],
    conversationId: 'conv-stdin-pre',
    stepIdx: 1,
  });
  assert.equal(denied.decision, 'deny');

  const allowed = runHookProcess(PRE_TOOL_BIN, {
    toolCall: { name: 'run_command', args: { CommandLine: 'npm test' } },
    workspacePaths: ['/repo'],
    conversationId: 'conv-stdin-pre',
    stepIdx: 2,
  });
  assert.equal(allowed.decision, 'allow');
});

test('Stop gate allows immediately when fullyIdle is false', async (t) => {
  const tempRepo = createDirtyGitRepo(t);

  const result = await evaluateStop(
    {
      terminationReason: 'NO_TOOL_CALL',
      fullyIdle: false,
      executionNum: 1,
      workspacePaths: [tempRepo],
      conversationId: 'conv-not-idle',
    },
    { env: { ...process.env, FACTORY_ENFORCE_STOP: '1' } }
  );

  assert.equal(result.decision, 'allow');
});

test('Stop gate respects opt-in config, enforces bounded loop protection, and honors verify receipts', async (t) => {
  const tempRepo = createDirtyGitRepo(t);

  fs.writeFileSync(
    path.join(tempRepo, '.factory.json'),
    JSON.stringify({ enforceStopVerify: false }, null, 2) + '\n',
    'utf8'
  );
  const past = new Date(Date.now() - 2000);
  fs.utimesSync(path.join(tempRepo, '.factory.json'), past, past);

  const unsetEnv = { ...process.env };
  delete unsetEnv.FACTORY_ENFORCE_STOP;

  const optOutResult = await evaluateStop(
    {
      terminationReason: 'NO_TOOL_CALL',
      fullyIdle: true,
      executionNum: 1,
      workspacePaths: [tempRepo],
      conversationId: 'conv-default-off',
    },
    { env: unsetEnv }
  );
  assert.equal(optOutResult.decision, 'allow');

  const enforcedEnv = { ...process.env, FACTORY_ENFORCE_STOP: '1' };
  const stopPayload = {
    terminationReason: 'NO_TOOL_CALL',
    fullyIdle: true,
    executionNum: 1,
    workspacePaths: [tempRepo],
    conversationId: 'conv-bounded-loop',
  };

  const firstAttempt = await evaluateStop(stopPayload, { env: enforcedEnv });
  assert.equal(firstAttempt.decision, 'continue');
  assert.equal(typeof firstAttempt.reason, 'string');
  assert.ok(firstAttempt.reason.length > 0);

  const secondAttempt = await evaluateStop(stopPayload, { env: enforcedEnv });
  assert.equal(secondAttempt.decision, 'allow');

  const verifyReceipt = await runVerify({ cwd: tempRepo, skipDocker: true });
  assert.equal(verifyReceipt.ok, true);

  const afterVerifyResult = await evaluateStop(
    {
      terminationReason: 'NO_TOOL_CALL',
      fullyIdle: true,
      executionNum: 1,
      workspacePaths: [tempRepo],
      conversationId: 'conv-fresh-after-verify',
    },
    { env: enforcedEnv }
  );
  assert.equal(afterVerifyResult.decision, 'allow');
});

test('Stop gate script reads JSON from stdin and writes bounded decision JSON to stdout', (t) => {
  const tempRepo = createDirtyGitRepo(t);
  const enforcedEnv = { ...process.env, FACTORY_ENFORCE_STOP: '1' };

  const payload = {
    terminationReason: 'NO_TOOL_CALL',
    fullyIdle: true,
    executionNum: 1,
    workspacePaths: [tempRepo],
    conversationId: 'conv-stop-stdin',
  };

  const first = runHookProcess(STOP_GATE_BIN, payload, enforcedEnv);
  assert.equal(first.decision, 'continue');

  const second = runHookProcess(STOP_GATE_BIN, payload, enforcedEnv);
  assert.equal(second.decision, 'allow');
});

test('PreToolUse guard blocks dot-segment .git/.env paths, slash/dot rm targets, and backtick substitutions', async () => {
  const dotGitConfig = await evaluatePreToolUse({
    toolCall: { name: 'write_file', args: { Path: '/repo/.git/./config' } },
    workspacePaths: ['/repo'],
    conversationId: 'conv-hardening',
    stepIdx: 1,
  });
  assert.equal(dotGitConfig.decision, 'deny');

  const dotDotGitHead = await evaluatePreToolUse({
    toolCall: { name: 'edit_file', args: { Path: '/repo/.git/refs/../HEAD' } },
    workspacePaths: ['/repo'],
    conversationId: 'conv-hardening',
    stepIdx: 2,
  });
  assert.equal(dotDotGitHead.decision, 'deny');

  const normalizedDotEnv = await evaluatePreToolUse({
    toolCall: { name: 'write_file', args: { Path: '/repo/sub/../.env' } },
    workspacePaths: ['/repo'],
    conversationId: 'conv-hardening',
    stepIdx: 3,
  });
  assert.equal(normalizedDotEnv.decision, 'deny');

  const rmDoubleSlash = await evaluatePreToolUse({
    toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf //' } },
    workspacePaths: ['/repo'],
    conversationId: 'conv-hardening',
    stepIdx: 4,
  });
  assert.equal(rmDoubleSlash.decision, 'deny');

  const rmSlashDot = await evaluatePreToolUse({
    toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf /.' } },
    workspacePaths: ['/repo'],
    conversationId: 'conv-hardening',
    stepIdx: 5,
  });
  assert.equal(rmSlashDot.decision, 'deny');

  const rmSlashDotDot = await evaluatePreToolUse({
    toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf /..' } },
    workspacePaths: ['/repo'],
    conversationId: 'conv-hardening',
    stepIdx: 6,
  });
  assert.equal(rmSlashDotDot.decision, 'deny');

  const backtickSub = await evaluatePreToolUse({
    toolCall: { name: 'run_command', args: { CommandLine: 'echo `rm -rf /`' } },
    workspacePaths: ['/repo'],
    conversationId: 'conv-hardening',
    stepIdx: 7,
  });
  assert.equal(backtickSub.decision, 'deny');

  const stdinBacktick = runHookProcess(PRE_TOOL_BIN, {
    toolCall: { name: 'run_command', args: { CommandLine: 'echo `rm -rf //`' } },
    workspacePaths: ['/repo'],
    conversationId: 'conv-hardening-stdin',
    stepIdx: 8,
  });
  assert.equal(stdinBacktick.decision, 'deny');
});

test('Stop gate invalidates verify receipt upon post-verify tracked file deletion or untracked file edit', async (t) => {
  const tempRepo = createDirtyGitRepo(t);
  const enforcedEnv = { ...process.env, FACTORY_ENFORCE_STOP: '1' };

  const removablePath = path.join(tempRepo, 'removable.js');
  fs.writeFileSync(removablePath, 'export const removable = true;\n', 'utf8');
  execFileSync('git', ['add', 'removable.js'], { cwd: tempRepo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'add removable file'], {
    cwd: tempRepo,
    stdio: 'ignore',
  });

  const untrackedPath = path.join(tempRepo, 'untracked-helper.js');
  fs.writeFileSync(untrackedPath, 'export const helperVersion = 1;\n', 'utf8');

  const firstReceipt = await runVerify({ cwd: tempRepo, skipDocker: true });
  assert.equal(firstReceipt.ok, true);

  const baselineAllow = await evaluateStop(
    {
      terminationReason: 'NO_TOOL_CALL',
      fullyIdle: true,
      executionNum: 1,
      workspacePaths: [tempRepo],
      conversationId: 'conv-digest-baseline',
    },
    { env: enforcedEnv }
  );
  assert.equal(baselineAllow.decision, 'allow');

  // 1) Delete a tracked file AFTER verify -> digest changes, must require re-verify ('continue')
  fs.unlinkSync(removablePath);

  const afterDeletion = await evaluateStop(
    {
      terminationReason: 'NO_TOOL_CALL',
      fullyIdle: true,
      executionNum: 1,
      workspacePaths: [tempRepo],
      conversationId: 'conv-after-tracked-deletion',
    },
    { env: enforcedEnv }
  );
  assert.equal(afterDeletion.decision, 'continue');

  // Re-verify current state -> allowed again
  const secondReceipt = await runVerify({ cwd: tempRepo, skipDocker: true });
  assert.equal(secondReceipt.ok, true);

  const reAllowed = await evaluateStop(
    {
      terminationReason: 'NO_TOOL_CALL',
      fullyIdle: true,
      executionNum: 1,
      workspacePaths: [tempRepo],
      conversationId: 'conv-reverified-after-deletion',
    },
    { env: enforcedEnv }
  );
  assert.equal(reAllowed.decision, 'allow');

  // 2) Edit an already-untracked file AFTER verify -> content sha256 changes, must return 'continue'
  fs.writeFileSync(untrackedPath, 'export const helperVersion = 2;\n', 'utf8');

  const afterUntrackedEdit = await evaluateStop(
    {
      terminationReason: 'NO_TOOL_CALL',
      fullyIdle: true,
      executionNum: 1,
      workspacePaths: [tempRepo],
      conversationId: 'conv-after-untracked-edit',
    },
    { env: enforcedEnv }
  );
  assert.equal(afterUntrackedEdit.decision, 'continue');
});

test('PreToolUse guard blocks receipt forgery (.factory/**) and holdout test tampering', async () => {
  const denyReceiptForge = await evaluatePreToolUse({
    toolCall: {
      name: 'write_file',
      args: { Path: '/repo/.factory/verify-receipt.json' },
    },
    workspacePaths: ['/repo'],
    conversationId: 'conv-dark-1',
    stepIdx: 1,
  });
  assert.equal(denyReceiptForge.decision, 'deny');
  assert.match(denyReceiptForge.reason, /\.factory/i);

  const denyHoldoutDir = await evaluatePreToolUse({
    toolCall: {
      name: 'edit_file',
      args: { Path: '/repo/tests/holdout/auth.test.js' },
    },
    workspacePaths: ['/repo'],
    conversationId: 'conv-dark-1',
    stepIdx: 2,
  });
  assert.equal(denyHoldoutDir.decision, 'deny');
  assert.match(denyHoldoutDir.reason, /holdout/i);

  const denyHoldoutSuffix = await evaluatePreToolUse({
    toolCall: {
      name: 'write_file',
      args: { Path: '/repo/tests/billing.holdout.test.js' },
    },
    workspacePaths: ['/repo'],
    conversationId: 'conv-dark-1',
    stepIdx: 3,
  });
  assert.equal(denyHoldoutSuffix.decision, 'deny');
  assert.match(denyHoldoutSuffix.reason, /holdout/i);

  const allowNormalTest = await evaluatePreToolUse({
    toolCall: {
      name: 'write_file',
      args: { Path: '/repo/tests/billing.test.js' },
    },
    workspacePaths: ['/repo'],
    conversationId: 'conv-dark-1',
    stepIdx: 4,
  });
  assert.equal(allowNormalTest.decision, 'allow');
});
