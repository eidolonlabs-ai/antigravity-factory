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
