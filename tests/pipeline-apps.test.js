import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import { detectProject } from '../plugins/agy-software-factory/lib/detect.js';
import { runVerify } from '../plugins/agy-software-factory/lib/verify.js';
import { runAuditDiff } from '../plugins/agy-software-factory/lib/audit-diff.js';
import { runInit } from '../plugins/agy-software-factory/lib/init.js';
import { runPlan, validateFactorySpec } from '../plugins/agy-software-factory/lib/spec.js';
import { runLand } from '../plugins/agy-software-factory/lib/land.js';
import {
  createTwinServer,
  signWebhookPayload,
  verifyWebhookSignature,
} from '../plugins/agy-software-factory/lib/twin.js';
import { runCli } from '../plugins/agy-software-factory/bin/agy-factory.js';
import { evaluatePreToolUse } from '../plugins/agy-software-factory/bin/pre-tool-guard.js';
import { evaluateStop } from '../plugins/agy-software-factory/bin/stop-verify-gate.js';

function withTempDir(prefix, fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function initGitRepo(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'factory-e2e@example.com'], {
    cwd: dir,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.name', 'Factory E2E'], {
    cwd: dir,
    stdio: 'ignore',
  });
}

test('E2E Pipeline App 1: Polyglot Python (unittest) + Node Monorepo through all 4 Factory stages', () => {
  withTempDir('agy-e2e-polyglot-', (tempDir) => {
    initGitRepo(tempDir);

    // Stage 0: Initialize Factory plugin in copy mode
    const initRes = runInit({ cwd: tempDir, mode: 'copy' });
    assert.equal(initRes.mode, 'copy');
    assert.ok(fs.existsSync(path.join(tempDir, '.factory.json')));

    // Scaffold polyglot monorepo: services/scoring (Python stdlib unittest) + packages/gateway (Node)
    const scoringDir = path.join(tempDir, 'services', 'scoring');
    const scoringTestsDir = path.join(scoringDir, 'tests');
    const gatewayDir = path.join(tempDir, 'packages', 'gateway');
    fs.mkdirSync(scoringTestsDir, { recursive: true });
    fs.mkdirSync(gatewayDir, { recursive: true });

    // Python component using stdlib unittest (no pytest installed/configured)
    fs.writeFileSync(
      path.join(scoringDir, 'pyproject.toml'),
      '[project]\nname = "scoring-service"\nversion = "0.1.0"\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(scoringDir, 'scoring.py'),
      'def compute_risk_score(amount, velocity):\n    return min(100, int(amount * 0.05 + velocity * 10))\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(scoringTestsDir, 'test_scoring.py'),
      [
        'import unittest',
        'from scoring import compute_risk_score',
        '',
        'class TestScoring(unittest.TestCase):',
        '    def test_low_risk(self):',
        '        self.assertEqual(compute_risk_score(100, 1), 15)',
        '',
        'if __name__ == "__main__":',
        '    unittest.main()',
      ].join('\n'),
      'utf8'
    );

    // Node gateway component
    fs.writeFileSync(
      path.join(gatewayDir, 'package.json'),
      JSON.stringify(
        {
          name: '@polyglot/gateway',
          version: '1.0.0',
          type: 'module',
          scripts: {
            test: 'node --test test.js',
            build: 'node -e "process.exit(0)"',
          },
        },
        null,
        2
      ),
      'utf8'
    );
    fs.writeFileSync(
      path.join(gatewayDir, 'index.js'),
      'export function formatDecision(score) { return score >= 70 ? "DECLINE" : "APPROVE"; }\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(gatewayDir, 'test.js'),
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { formatDecision } from "./index.js";',
        'test("formatDecision", () => {',
        '  assert.equal(formatDecision(15), "APPROVE");',
        '  assert.equal(formatDecision(85), "DECLINE");',
        '});',
      ].join('\n'),
      'utf8'
    );

    execFileSync('git', ['add', '.'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'Initial polyglot scaffold'], {
      cwd: tempDir,
      stdio: 'ignore',
    });

    // Stage 1: Detect stack & verify Python stdlib unittest command selection
    const detected = detectProject(tempDir);
    const pyComp = detected.components.find((c) => c.relPath === 'services/scoring');
    const nodeComp = detected.components.find((c) => c.relPath === 'packages/gateway');
    assert.ok(pyComp, 'Expected services/scoring Python component');
    assert.equal(pyComp.type, 'python');
    assert.equal(
      pyComp.commands.test,
      'python3 -m unittest discover -s tests -p "test*.py"'
    );
    assert.ok(nodeComp, 'Expected packages/gateway Node component');
    assert.equal(nodeComp.type, 'node');

    // Stage 2: Simulate isolated git worktree slice builds with --allow-paths boundary checks
    const wtScoring = path.join(tempDir, '..', `wt-scoring-${Date.now()}`);
    try {
      execFileSync('git', ['worktree', 'add', '-b', 'slice-scoring', wtScoring], {
        cwd: tempDir,
        stdio: 'ignore',
      });

      // Builder adds a feature in its owned slice AND accidentally touches packages/gateway/index.js
      fs.writeFileSync(
        path.join(wtScoring, 'services', 'scoring', 'scoring.py'),
        [
          'def compute_risk_score(amount, velocity):',
          '    if amount < 0 or velocity < 0:',
          '        raise ValueError("negative input")',
          '    return min(100, int(amount * 0.05 + velocity * 10))',
        ].join('\n') + '\n',
        'utf8'
      );
      fs.appendFileSync(
        path.join(wtScoring, 'packages', 'gateway', 'index.js'),
        '// unauthorized cross-slice edit\n',
        'utf8'
      );

      const boundaryFail = runAuditDiff({
        cwd: wtScoring,
        allowPaths: ['services/scoring/**'],
      });
      assert.equal(boundaryFail.status, 'FLAGGED');
      assert.ok(
        boundaryFail.findings.some(
          (f) =>
            f.rule === 'slice-boundary-violation' &&
            f.file === 'packages/gateway/index.js'
        )
      );

      // Revert out-of-slice file and re-verify slice boundary
      execFileSync('git', ['checkout', '--', 'packages/gateway/index.js'], {
        cwd: wtScoring,
        stdio: 'ignore',
      });
      const boundaryPass = runAuditDiff({
        cwd: wtScoring,
        allowPaths: ['services/scoring/**'],
      });
      assert.equal(boundaryPass.status, 'APPROVE_CANDIDATE');
      assert.equal(boundaryPass.findings.length, 0);

      // Land slice into main workspace
      fs.copyFileSync(
        path.join(wtScoring, 'services', 'scoring', 'scoring.py'),
        path.join(scoringDir, 'scoring.py')
      );
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', wtScoring], {
        cwd: tempDir,
        stdio: 'ignore',
      });
    }

    // Stage 3: Run deterministic verification (executes both Python unittest and Node test)
    const verifyRes = runVerify({ cwd: tempDir, requireTests: true });
    assert.equal(verifyRes.ok, true, `Expected verify ok: ${JSON.stringify(verifyRes.checks)}`);
    const pyTestCheck = verifyRes.checks.find((c) => c.id === 'services/scoring:test');
    const nodeTestCheck = verifyRes.checks.find((c) => c.id === 'packages/gateway:test');
    assert.equal(pyTestCheck?.status, 'PASS');
    assert.equal(nodeTestCheck?.status, 'PASS');

    // Stage 4: Inject Python f-string SQL vulnerability, verify Stop gate & audit-diff catch it
    const badPySql = ['f"', 'SELECT score FROM risk_profiles WHERE handle = ', "'{handle}'", '"'].join('');
    fs.appendFileSync(
      path.join(scoringDir, 'scoring.py'),
      `\ndef unsafe_lookup(conn, handle):\n    return conn.execute(${badPySql})\n`,
      'utf8'
    );

    const stopBlocked = evaluateStop(
      { workspacePaths: [tempDir], fullyIdle: true },
      { env: { ...process.env, FACTORY_ENFORCE_STOP: '1' } }
    );
    assert.equal(stopBlocked.decision, 'continue');

    const auditFlagged = runAuditDiff({ cwd: tempDir });
    assert.equal(auditFlagged.status, 'FLAGGED');
    assert.ok(
      auditFlagged.findings.some(
        (f) => f.rule === 'sql-interpolation' && f.file === 'services/scoring/scoring.py'
      )
    );

    // Fix to parameterized query, re-run Stage 3 & Stage 4
    fs.writeFileSync(
      path.join(scoringDir, 'scoring.py'),
      [
        'def compute_risk_score(amount, velocity):',
        '    if amount < 0 or velocity < 0:',
        '        raise ValueError("negative input")',
        '    return min(100, int(amount * 0.05 + velocity * 10))',
        '',
        'def safe_lookup(conn, handle):',
        '    return conn.execute("SELECT score FROM risk_profiles WHERE handle = ?", (handle,))',
      ].join('\n') + '\n',
      'utf8'
    );

    const finalVerify = runVerify({ cwd: tempDir }); // uses requireTests: true from .factory.json
    assert.equal(finalVerify.ok, true);
    assert.equal(finalVerify.requireTests, true);

    const finalAudit = runAuditDiff({ cwd: tempDir });
    assert.equal(finalAudit.status, 'APPROVE_CANDIDATE');
    assert.equal(finalAudit.findings.length, 0);

    const stopAllowed = evaluateStop(
      { workspacePaths: [tempDir], fullyIdle: true },
      { env: { ...process.env, FACTORY_ENFORCE_STOP: '1' } }
    );
    assert.equal(stopAllowed.decision, 'allow');
  });
});

test('E2E Pipeline App 2: Expense Ledger App with Dark Factory holdout protection & SQL/exec/XSS audit checks', () => {
  withTempDir('agy-e2e-ledger-', (tempDir) => {
    initGitRepo(tempDir);
    runInit({ cwd: tempDir, mode: 'link' });

    const apiDir = path.join(tempDir, 'api');
    const holdoutDir = path.join(tempDir, 'holdout');
    fs.mkdirSync(apiDir, { recursive: true });
    fs.mkdirSync(holdoutDir, { recursive: true });

    fs.writeFileSync(
      path.join(apiDir, 'package.json'),
      JSON.stringify(
        {
          name: 'ledger-api',
          version: '1.0.0',
          type: 'module',
          scripts: {
            test: 'node --test ledger.test.js ../holdout/ledger.holdout.test.js',
          },
        },
        null,
        2
      ),
      'utf8'
    );

    // Parameterized dynamic UPDATE query like examples/task-tracker/api/src/app.js
    fs.writeFileSync(
      path.join(apiDir, 'ledger.js'),
      [
        'export function settleBalance(entries) {',
        '  return entries.reduce((sum, e) => sum + Number(e.amount || 0), 0);',
        '}',
        '',
        'export async function updateLedgerRow(pool, id, fields, values) {',
        '  return pool.query(`UPDATE ledger SET ${fields.join(", ")} WHERE id = $${values.length}`, values);',
        '}',
      ].join('\n') + '\n',
      'utf8'
    );

    fs.writeFileSync(
      path.join(apiDir, 'ledger.test.js'),
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { settleBalance } from "./ledger.js";',
        'test("settleBalance sums positive and negative entries", () => {',
        '  assert.equal(settleBalance([{ amount: 50 }, { amount: -20 }]), 30);',
        '});',
      ].join('\n'),
      'utf8'
    );

    fs.writeFileSync(
      path.join(holdoutDir, 'ledger.holdout.test.js'),
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { settleBalance } from "../api/ledger.js";',
        'test("holdout: handles string amounts and empty list", () => {',
        '  assert.equal(settleBalance([]), 0);',
        '  assert.equal(settleBalance([{ amount: "12.5" }, { amount: "7.5" }]), 20);',
        '});',
      ].join('\n'),
      'utf8'
    );

    // Verify PreToolUse guard blocks shell redirection / rm / tee against .factory/** and holdout/**
    assert.equal(
      evaluatePreToolUse({
        toolCall: {
          name: 'run_command',
          args: { CommandLine: 'echo \'{"ok":true}\' > .factory/verify-receipt.json' },
        },
      }).decision,
      'deny'
    );
    assert.equal(
      evaluatePreToolUse({
        toolCall: {
          name: 'run_command',
          args: { CommandLine: 'rm -f .factory/verify-receipt.json' },
        },
      }).decision,
      'deny'
    );
    assert.equal(
      evaluatePreToolUse({
        toolCall: {
          name: 'run_command',
          args: { CommandLine: 'cat fake.js | tee holdout/ledger.holdout.test.js' },
        },
      }).decision,
      'deny'
    );
    assert.equal(
      evaluatePreToolUse({
        toolCall: {
          name: 'run_command',
          args: { CommandLine: 'cp .env.example .env' },
        },
      }).decision,
      'deny'
    );
    // Reading .factory/verify-receipt.json via cp to /tmp is allowed
    assert.equal(
      evaluatePreToolUse({
        toolCall: {
          name: 'run_command',
          args: { CommandLine: 'cp .factory/verify-receipt.json /tmp/receipt-backup.json' },
        },
      }).decision,
      'allow'
    );

    // Inject UPDATE SQLi and shell exec interpolation to verify audit-diff catches them
    const badUpdateLine = ['return db.query(`UPDATE ledger SET status = ', "'$" + "{status}' WHERE id = $" + "{id}`);"].join('');
    const badExecLine = ['return execSync(`tar -czf /tmp/$', '{filename}.tar.gz ./data`);'].join('');
    fs.writeFileSync(
      path.join(apiDir, 'unsafe.js'),
      [
        'import { execSync } from "node:child_process";',
        'export function badUpdate(db, id, status) {',
        `  ${badUpdateLine}`,
        '}',
        'export function badExport(filename) {',
        `  ${badExecLine}`,
        '}',
      ].join('\n') + '\n',
      'utf8'
    );

    const flagged = runAuditDiff({ cwd: tempDir, allFiles: true });
    assert.equal(flagged.status, 'FLAGGED');
    assert.ok(flagged.findings.some((f) => f.rule === 'sql-interpolation' && f.file === 'api/unsafe.js'));
    assert.ok(flagged.findings.some((f) => f.rule === 'dangerous-exec' && f.file === 'api/unsafe.js'));
    // Ensure parameterized `UPDATE ledger SET ${fields.join(", ")} WHERE id = $${values.length}` in api/ledger.js was NOT flagged
    assert.ok(!flagged.findings.some((f) => f.file === 'api/ledger.js'));

    // Remove unsafe file and run full verification
    fs.rmSync(path.join(apiDir, 'unsafe.js'));
    const cleanAudit = runAuditDiff({ cwd: tempDir, allFiles: true });
    assert.equal(cleanAudit.status, 'APPROVE_CANDIDATE');

    const verifyReceipt = runVerify({ cwd: tempDir });
    assert.equal(verifyReceipt.ok, true);
    assert.equal(
      verifyReceipt.checks.find((c) => c.id === 'api:test')?.status,
      'PASS'
    );
  });
});

test('E2E Pipeline App 3: Polyglot root directory + child component name collision disambiguation', () => {
  withTempDir('agy-e2e-collision-', (tempDir) => {
    const dirBaseName = path.basename(tempDir);
    // Root has BOTH package.json AND pyproject.toml + tests/, PLUS child ./<dirBaseName>/package.json
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify(
        {
          name: dirBaseName,
          version: '1.0.0',
          scripts: {
            test: 'node -e "process.exit(0)"',
          },
        },
        null,
        2
      ),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tempDir, 'pyproject.toml'),
      '[project]\nname = "worker-py"\nversion = "0.1.0"\n',
      'utf8'
    );
    fs.mkdirSync(path.join(tempDir, 'tests'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'tests', 'test_root.py'),
      [
        'import unittest',
        'class TestRoot(unittest.TestCase):',
        '    def test_ok(self):',
        '        self.assertTrue(True)',
      ].join('\n'),
      'utf8'
    );

    const childWorkerDir = path.join(tempDir, dirBaseName);
    fs.mkdirSync(childWorkerDir, { recursive: true });
    fs.writeFileSync(
      path.join(childWorkerDir, 'package.json'),
      JSON.stringify(
        {
          name: dirBaseName,
          version: '1.0.0',
          scripts: {
            test: 'node -e "process.exit(0)"',
          },
        },
        null,
        2
      ),
      'utf8'
    );

    const receipt = runVerify({ cwd: tempDir, requireTests: true });
    assert.equal(receipt.ok, true);

    const testCheckIds = receipt.checks
      .filter((c) => c.category === 'test')
      .map((c) => c.id);
    assert.equal(testCheckIds.length, 3);
    assert.equal(
      new Set(testCheckIds).size,
      3,
      `Expected 3 distinct check IDs, got: ${JSON.stringify(testCheckIds)}`
    );
    assert.deepEqual(testCheckIds, [
      `root:${dirBaseName}:test`,
      `root:${dirBaseName}(python):test`,
      `${dirBaseName}:test`,
    ]);
  });
});

test('E2E Pipeline App 4: Monorepo libs/* and modules/* discovery', () => {
  withTempDir('agy-e2e-libs-', (tempDir) => {
    const mathLibDir = path.join(tempDir, 'libs', 'math');
    const authModDir = path.join(tempDir, 'modules', 'auth');
    fs.mkdirSync(mathLibDir, { recursive: true });
    fs.mkdirSync(authModDir, { recursive: true });

    fs.writeFileSync(
      path.join(mathLibDir, 'package.json'),
      JSON.stringify({ name: '@acme/math', scripts: { test: 'node -e "process.exit(0)"' } }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(authModDir, 'Cargo.toml'),
      '[package]\nname = "auth"\nversion = "0.1.0"\n',
      'utf8'
    );

    const project = detectProject(tempDir);
    const relPaths = project.components.map((c) => c.relPath);
    assert.ok(relPaths.includes('libs/math'));
    assert.ok(relPaths.includes('modules/auth'));
  });
});

test('E2E Pipeline App 5: Declarative Slice Manifest (.factory/spec.json), PreToolUse FACTORY_SLICE enforcement, and Worktree Landing (agy-factory land)', () => {
  withTempDir('agy-e2e-spec-land-', (tempDir) => {
    initGitRepo(tempDir);

    const apiDir = path.join(tempDir, 'api');
    const webDir = path.join(tempDir, 'web');
    fs.mkdirSync(apiDir, { recursive: true });
    fs.mkdirSync(webDir, { recursive: true });

    fs.writeFileSync(
      path.join(apiDir, 'package.json'),
      JSON.stringify({ name: 'api', scripts: { test: 'node -e "process.exit(0)"' } }),
      'utf8'
    );
    fs.writeFileSync(path.join(apiDir, 'server.js'), 'export const v = 1;\n', 'utf8');
    fs.writeFileSync(path.join(apiDir, 'old.js'), 'export const old = true;\n', 'utf8');
    fs.writeFileSync(
      path.join(webDir, 'package.json'),
      JSON.stringify({ name: 'web', scripts: { build: 'node -e "process.exit(0)"' } }),
      'utf8'
    );
    fs.writeFileSync(path.join(webDir, 'app.js'), 'export const ui = 1;\n', 'utf8');

    execFileSync('git', ['add', '.'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'Initial api + web'], {
      cwd: tempDir,
      stdio: 'ignore',
    });

    // 1. Scaffold and validate .factory/spec.json via runPlan({ init: true })
    const planRes = runPlan({ cwd: tempDir, init: true });
    assert.equal(planRes.ok, true);
    assert.equal(planRes.valid, true);
    assert.deepEqual(planRes.slices.sort(), ['api', 'web']);

    // Verify overlapping slice validation catches conflicts
    const overlapCheck = validateFactorySpec({
      slices: {
        api: { allowPaths: ['api/**'] },
        routes: { allowPaths: ['api/routes/**'] },
      },
    });
    assert.equal(overlapCheck.valid, false);
    assert.ok(overlapCheck.errors[0].includes('Overlapping slice ownership'));

    // 2. Verify PreToolUse blocks out-of-slice writes when FACTORY_SLICE=api is active
    const allowedSliceWrite = evaluatePreToolUse(
      {
        workspacePaths: [tempDir],
        toolCall: {
          name: 'write_file',
          args: { Path: path.join(tempDir, 'api', 'new-route.js') },
        },
      },
      { env: { ...process.env, FACTORY_SLICE: 'api' } }
    );
    assert.equal(allowedSliceWrite.decision, 'allow');

    const blockedSliceWrite = evaluatePreToolUse(
      {
        workspacePaths: [tempDir],
        toolCall: {
          name: 'edit_file',
          args: { Path: path.join(tempDir, 'web', 'app.js') },
        },
      },
      { env: { ...process.env, FACTORY_SLICE: 'api' } }
    );
    assert.equal(blockedSliceWrite.decision, 'deny');
    assert.ok(blockedSliceWrite.reason.includes('out-of-slice'));

    // 3. Test automated worktree landing (runLand)
    const wtApi = path.join(tempDir, '..', `wt-land-api-${Date.now()}`);
    try {
      execFileSync('git', ['worktree', 'add', '-b', 'slice-land-api', wtApi], {
        cwd: tempDir,
        stdio: 'ignore',
      });

      // Modify api/server.js, delete api/old.js, and touch out-of-slice web/app.js
      fs.writeFileSync(path.join(wtApi, 'api', 'server.js'), 'export const v = 2;\n', 'utf8');
      fs.rmSync(path.join(wtApi, 'api', 'old.js'));
      fs.appendFileSync(path.join(wtApi, 'web', 'app.js'), '// out of slice\n', 'utf8');

      // Landing must block while out-of-slice edit exists
      const blockedLand = runLand({
        cwd: tempDir,
        worktree: wtApi,
        slice: 'api',
      });
      assert.equal(blockedLand.ok, false);
      assert.equal(fs.readFileSync(path.join(apiDir, 'server.js'), 'utf8'), 'export const v = 1;\n');

      // Revert out-of-slice file in worktree
      execFileSync('git', ['checkout', '--', 'web/app.js'], {
        cwd: wtApi,
        stdio: 'ignore',
      });

      // Dry-run land previews without writing
      const dryLand = runLand({
        cwd: tempDir,
        worktree: wtApi,
        slice: 'api',
        dryRun: true,
      });
      assert.equal(dryLand.ok, true);
      assert.deepEqual(dryLand.landedFiles, ['api/server.js']);
      assert.deepEqual(dryLand.deletedFiles, ['api/old.js']);
      assert.equal(fs.readFileSync(path.join(apiDir, 'server.js'), 'utf8'), 'export const v = 1;\n');
      assert.ok(fs.existsSync(path.join(apiDir, 'old.js')));

      // Real land applies modified and deleted files cleanly
      const realLand = runLand({
        cwd: tempDir,
        worktree: wtApi,
        slice: 'api',
      });
      assert.equal(realLand.ok, true);
      assert.equal(fs.readFileSync(path.join(apiDir, 'server.js'), 'utf8'), 'export const v = 2;\n');
      assert.ok(!fs.existsSync(path.join(apiDir, 'old.js')));
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', wtApi], {
        cwd: tempDir,
        stdio: 'ignore',
      });
    }
  });
});

test('E2E Pipeline App 6: Digital Twin Universe (DTU) behavioral HTTP mock, stateful routes, and HMAC webhook verification', async () => {
  const twin = createTwinServer({
    initialState: { charges: [] },
    routes: [
      {
        method: 'POST',
        path: '/v1/charges',
        handler: (req, state) => {
          const charge = {
            id: `ch_${state.charges.length + 1}`,
            amount: req.body?.amount ?? 0,
            currency: req.body?.currency ?? 'usd',
          };
          state.charges.push(charge);
          return { status: 201, body: charge };
        },
      },
      {
        method: 'GET',
        path: '/v1/charges/:id',
        handler: (req, state) => {
          const found = state.charges.find((c) => c.id === req.params.id);
          if (!found) return { status: 404, body: { error: 'not_found' } };
          return { status: 200, body: found };
        },
      },
    ],
  });

  const started = await twin.listen(0);
  try {
    const createRes = await fetch(`${started.url}/v1/charges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 4200, currency: 'usd' }),
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    assert.equal(created.id, 'ch_1');
    assert.equal(created.amount, 4200);

    const getRes = await fetch(`${started.url}/v1/charges/ch_1`);
    assert.equal(getRes.status, 200);
    const fetched = await getRes.json();
    assert.equal(fetched.amount, 4200);

    const reqsRes = await fetch(`${started.url}/__twin/requests`);
    const { requests } = await reqsRes.json();
    assert.equal(requests.length, 2);

    // Webhook signature verification helper
    const payload = JSON.stringify({ event: 'charge.succeeded', data: created });
    const sig = signWebhookPayload(payload, 'whsec_test_secret');
    assert.equal(verifyWebhookSignature(payload, sig, 'whsec_test_secret'), true);
    assert.equal(verifyWebhookSignature(payload, sig, 'wrong_secret'), false);

    // Reset state
    await fetch(`${started.url}/__twin/reset`, { method: 'POST' });
    assert.equal(started.getRequests().length, 0);
  } finally {
    await started.close();
  }
});

test('E2E Pipeline App 7: Cross-Agent Portability (init --target all), Claude/Gemini Hook Payloads, and Markdown/SARIF output', () => {
  withTempDir('agy-e2e-multi-agent-', (tempDir) => {
    initGitRepo(tempDir);

    const initRes = runInit({
      cwd: tempDir,
      mode: 'copy',
      target: 'all',
    });

    assert.ok(fs.existsSync(initRes.pluginsJsonPath));
    assert.ok(fs.existsSync(initRes.claudeSettingsPath));
    assert.ok(fs.existsSync(path.join(tempDir, 'CLAUDE.md')));
    assert.ok(fs.existsSync(initRes.geminiSettingsPath));
    assert.ok(fs.existsSync(initRes.gitPreCommitPath));

    // Verify Claude Code payload compatibility in PreToolUse & Stop hooks
    assert.equal(
      evaluatePreToolUse({
        tool_name: 'Write',
        tool_input: { file_path: '.env' },
      }).decision,
      'deny'
    );
    assert.equal(
      evaluatePreToolUse({
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
      }).decision,
      'deny'
    );
    assert.equal(
      evaluateStop(
        { workspacePaths: [tempDir], stop_hook_active: true },
        { env: { ...process.env, FACTORY_ENFORCE_STOP: '1' } }
      ).decision,
      'allow'
    );

    // Verify Markdown & SARIF CLI output formats
    let stdoutBuf = '';
    const customIo = {
      stdout: { write: (s) => { stdoutBuf += s; } },
      stderr: { write: () => {} },
    };

    const badFile = path.join(tempDir, 'vuln.js');
    fs.writeFileSync(badFile, ['const x = eval', '("2 + 2");\n'].join(''), 'utf8');

    const sarifExit = runCli(
      ['audit-diff', '--cwd', tempDir, '--all', '--format', 'sarif'],
      customIo
    );
    assert.equal(sarifExit, 1);
    const sarif = JSON.parse(stdoutBuf);
    assert.equal(sarif.version, '2.1.0');
    assert.equal(sarif.runs[0].results[0].ruleId, 'dangerous-exec');
    assert.equal(
      sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri,
      'vuln.js'
    );

    fs.rmSync(badFile);
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'multi-agent-app', scripts: { test: 'node -e "process.exit(0)"' } }),
      'utf8'
    );
    stdoutBuf = '';
    const summaryFile = path.join(tempDir, 'step-summary.md');
    const prevSummaryEnv = process.env.GITHUB_STEP_SUMMARY;
    process.env.GITHUB_STEP_SUMMARY = summaryFile;
    try {
      const mdExit = runCli(
        ['verify', '--cwd', tempDir, '--format', 'markdown', '--github-summary'],
        customIo
      );
      assert.equal(mdExit, 0);
      assert.ok(stdoutBuf.includes('## Software Factory Verification: PASS'));
      assert.ok(fs.readFileSync(summaryFile, 'utf8').includes('| **PASS** | `workspace` | `hygiene` |'));
    } finally {
      if (prevSummaryEnv === undefined) {
        delete process.env.GITHUB_STEP_SUMMARY;
      } else {
        process.env.GITHUB_STEP_SUMMARY = prevSummaryEnv;
      }
    }
  });
});

test('E2E Pipeline App 8: Non-destructive init merging, git worktrees, CLAUDE.md rule path, and Twin CLI bounds', async () => {
  withTempDir('agy-e2e-init-worktree-', (tempDir) => {
    initGitRepo(tempDir);
    fs.writeFileSync(path.join(tempDir, 'index.js'), 'export const ok = true;\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: tempDir, stdio: 'ignore' });

    // Pre-populate .claude/settings.json, .gemini/settings.json, and custom pre-commit hook
    fs.mkdirSync(path.join(tempDir, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, '.claude', 'settings.json'),
      JSON.stringify({
        permissions: { allow: ['Read'] },
        hooks: {
          Notification: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo notify' }] }],
        },
      }),
      'utf8'
    );

    fs.mkdirSync(path.join(tempDir, '.gemini'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, '.gemini', 'settings.json'),
      JSON.stringify({
        mcpServers: { existingServer: { command: 'node', args: ['mcp.js'] } },
      }),
      'utf8'
    );

    const hooksDir = path.join(tempDir, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(
      path.join(hooksDir, 'pre-commit'),
      '#!/usr/bin/env sh\necho "existing-check"\n',
      { encoding: 'utf8', mode: 0o755 }
    );

    // Run init twice to verify non-destructive merge AND idempotency
    runInit({ cwd: tempDir, mode: 'copy', target: 'all' });
    const secondInit = runInit({ cwd: tempDir, mode: 'copy', target: 'all' });

    const claudeSettings = JSON.parse(fs.readFileSync(secondInit.claudeSettingsPath, 'utf8'));
    assert.deepEqual(claudeSettings.permissions, { allow: ['Read'] });
    assert.equal(claudeSettings.hooks.Notification.length, 1);
    assert.equal(claudeSettings.hooks.PreToolUse.length, 1);
    assert.equal(claudeSettings.hooks.Stop.length, 1);

    const geminiSettings = JSON.parse(fs.readFileSync(secondInit.geminiSettingsPath, 'utf8'));
    assert.deepEqual(geminiSettings.mcpServers, {
      existingServer: { command: 'node', args: ['mcp.js'] },
    });
    assert.equal(geminiSettings.hooks.BeforeTool.length, 1);
    assert.equal(geminiSettings.hooks.AfterAgent.length, 1);

    // External repo without root AGENTS.md points CLAUDE.md at bundled plugin rules
    const claudeMd = fs.readFileSync(path.join(tempDir, 'CLAUDE.md'), 'utf8');
    assert.ok(claudeMd.includes('@.agents/plugins/agy-software-factory/rules/AGENTS.md'));

    // Custom pre-commit hook preserved alongside factory gate lines
    const preCommitText = fs.readFileSync(secondInit.gitPreCommitPath, 'utf8');
    assert.ok(preCommitText.includes('echo "existing-check"'));
    assert.ok(preCommitText.includes('agy-factory.js'));

    // Verify git worktree (.git file with gitdir:) support without ENOTDIR
    const wtDir = path.join(tempDir, '..', `wt-init-${Date.now()}`);
    try {
      execFileSync('git', ['worktree', 'add', '-b', 'wt-codex-branch', wtDir], {
        cwd: tempDir,
        stdio: 'ignore',
      });
      assert.equal(fs.statSync(path.join(wtDir, '.git')).isFile(), true);
      const wtInit = runInit({ cwd: wtDir, mode: 'copy', target: 'codex' });
      assert.ok(wtInit.gitPreCommitPath);
      assert.ok(fs.existsSync(wtInit.gitPreCommitPath));
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', wtDir], {
        cwd: tempDir,
        stdio: 'ignore',
      });
    }
  });

  // Verify Twin maxBodyBytes (HTTP 413), CLI --port validation, and EADDRINUSE handling
  const boundedTwin = createTwinServer({
    maxBodyBytes: 32,
    routes: [{ method: 'POST', path: '/upload', response: { ok: true } }],
  });
  const started = await boundedTwin.listen(0);
  try {
    const okRes = await fetch(`${started.url}/upload`, {
      method: 'POST',
      body: JSON.stringify({ tiny: 1 }),
    });
    assert.equal(okRes.status, 200);

    const tooBigRes = await fetch(`${started.url}/upload`, {
      method: 'POST',
      body: 'x'.repeat(128),
    });
    assert.equal(tooBigRes.status, 413);
    const errBody = await tooBigRes.json();
    assert.equal(errBody.error, 'Payload Too Large');

    // Synchronous --port validation in runCli
    let errBuf = '';
    const errIo = {
      stdout: { write: () => {} },
      stderr: { write: (s) => { errBuf += s; } },
    };
    assert.equal(runCli(['twin', '--port', 'not-a-port'], errIo), 1);
    assert.match(errBuf, /Invalid --port/i);
    assert.equal(runCli(['twin', '--port', '70000'], errIo), 1);

    // Subprocess EADDRINUSE on occupied port exits cleanly with code 1 (no UnhandledPromiseRejection)
    const cliBin = path.resolve('bin/agy-factory.js');
    let occupiedErr = null;
    try {
      execFileSync(process.execPath, [cliBin, 'twin', '--port', String(started.port)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      occupiedErr = e;
    }
    assert.ok(occupiedErr, 'Expected twin CLI on occupied port to exit non-zero');
    assert.equal(occupiedErr.status, 1);
    assert.match(occupiedErr.stderr, /EADDRINUSE/i);
    assert.doesNotMatch(occupiedErr.stderr, /UnhandledPromiseRejection/);
  } finally {
    await started.close();
  }
});
