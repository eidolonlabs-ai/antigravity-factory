#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { detectProject } from '../lib/detect.js';
import { runVerify } from '../lib/verify.js';
import { runAuditDiff } from '../lib/audit-diff.js';
import { runInit } from '../lib/init.js';
import { runPlan } from '../lib/spec.js';
import { runLand } from '../lib/land.js';
import { createTwinServer, loadTwinRoutesFromFile } from '../lib/twin.js';
import {
  formatVerifyMarkdown,
  formatAuditMarkdown,
  formatAuditSarif,
} from '../lib/formatters.js';

const HELP_TEXT = `Antigravity Software Factory CLI (agy-factory)

Usage:
  agy-factory <command> [options]

Commands:
  detect                 Inventory project stack, Docker Compose, and scripts
  plan                   Scaffold (--init) or validate .factory/spec.json slice ownership
  verify                 Run deterministic QA checks and write .factory/verify-receipt.json
  audit-diff             Scan git diff / untracked files for secrets, sinks, and slice boundaries
  land                   Verify and land an isolated git worktree slice into the workspace
  twin                   Start a zero-dependency Digital Twin Universe (DTU) mock HTTP server
  init [targetDir]       Configure Software Factory for Antigravity, Claude, Gemini, or Codex

Options:
  --cwd <dir>            Target working directory (defaults to current directory)
  --json                 Emit machine-readable JSON output
  --format <fmt>         Output format: text | json | markdown | sarif (default: text)
  --github-summary       Append Markdown report to $GITHUB_STEP_SUMMARY if set
  --require-tests        Fail verify if no test suite passes (NOT_RUN is not PASS)
  --skip-docker          Skip docker compose validation during verify
  --base <ref>           Additional git base ref to diff against in audit-diff
  --all                  Scan all workspace files in audit-diff instead of git diff only
  --allow-paths <list>   Comma-separated owned paths/globs to enforce in audit-diff or land
  --slice <name>         Slice name from .factory/spec.json for plan, audit-diff, or land
  --worktree <dir>       Source worker git worktree directory for land
  --dry-run              Preview files to land without modifying target workspace
  --force                Force land even if audit-diff reports findings
  --init                 Scaffold a starter .factory/spec.json when running plan
  --routes <file>        JSON routes file for twin server
  --port <number>        TCP port for twin server (default: 0 for random available port)
  --mode <link|copy>     Plugin installation mode for init (default: link)
  --target <targets>     Agent target(s) for init: agy | claude | gemini | codex | all (default: agy)
  -h, --help             Show this help message
`;

function normalizeArgv(argv) {
  if (!Array.isArray(argv)) {
    return process.argv.slice(2);
  }
  if (
    argv.length >= 2 &&
    typeof argv[0] === 'string' &&
    typeof argv[1] === 'string' &&
    /(?:^|[\\/])node(?:\.exe)?$/i.test(argv[0]) &&
    argv[1].endsWith('.js')
  ) {
    return argv.slice(2);
  }
  return argv;
}

function pad(str, width) {
  const text = String(str ?? '');
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function formatDetectHuman(project) {
  const lines = [
    `Workspace Root : ${project.root}`,
    `Docker Compose : ${project.hasDockerCompose ? `yes (${project.dockerComposeFile})` : 'no'}`,
    `Components     : ${project.components.length}`,
  ];

  if (project.components.length > 0) {
    lines.push('');
    lines.push(`${pad('COMPONENT', 20)} ${pad('PATH', 16)} ${pad('TYPE', 10)} COMMANDS`);
    lines.push('-'.repeat(76));
    for (const comp of project.components) {
      const cmdSummary = Object.entries(comp.commands || {})
        .map(([k, v]) => `${k}="${v}"`)
        .join(', ') || '(none)';
      lines.push(
        `${pad(comp.name, 20)} ${pad(comp.relPath, 16)} ${pad(comp.type, 10)} ${cmdSummary}`
      );
    }
  }

  return lines.join('\n');
}

function formatVerifyHuman(receipt) {
  const lines = [
    `Workspace : ${receipt.cwd}`,
    `Digest    : ${receipt.digest.slice(0, 16)}...`,
    '',
    `${pad('STATUS', 10)} ${pad('COMPONENT', 18)} ${pad('CATEGORY', 16)} ${pad('TIME', 9)} DETAILS`,
    '-'.repeat(80),
  ];

  for (const check of receipt.checks) {
    const timeStr = check.status === 'NOT_RUN' ? '-' : `${check.durationMs}ms`;
    const detail = check.command || check.output || '';
    lines.push(
      `${pad(check.status, 10)} ${pad(check.component, 18)} ${pad(check.category, 16)} ${pad(timeStr, 9)} ${detail}`
    );
    if (check.status === 'FAIL' && check.output) {
      const snippet = check.output.split('\n').slice(-6).join('\n    ');
      lines.push(`    -> ${snippet}`);
    }
  }

  lines.push('-'.repeat(80));
  lines.push(
    `Summary   : ${receipt.summary.pass} PASS, ${receipt.summary.fail} FAIL, ${receipt.summary.notRun} NOT_RUN` +
      (receipt.requireTests ? ' (--require-tests)' : '')
  );
  lines.push(`Verdict   : ${receipt.ok ? 'PASS' : 'FAIL'}`);
  lines.push(`Receipt   : ${path.join(receipt.cwd, '.factory', 'verify-receipt.json')}`);

  return lines.join('\n');
}

function formatAuditHuman(report) {
  const lines = [
    `Workspace     : ${report.cwd}`,
    `Files Scanned : ${report.filesScanned}`,
    `Findings      : ${report.findings.length}`,
    `Status        : ${report.status}`,
  ];

  if (report.findings.length > 0) {
    lines.push('');
    lines.push(`${pad('SEVERITY', 10)} ${pad('RULE', 20)} ${pad('LOCATION', 30)} MESSAGE`);
    lines.push('-'.repeat(84));
    for (const f of report.findings) {
      const loc = `${f.file}:${f.line}`;
      lines.push(`${pad(f.severity.toUpperCase(), 10)} ${pad(f.rule, 20)} ${pad(loc, 30)} ${f.message}`);
      if (f.snippet) {
        lines.push(`    ${f.snippet}`);
      }
    }
  }

  return lines.join('\n');
}

function formatInitHuman(res) {
  const lines = [
    `Initialized Software Factory (${res.mode} mode, targets: ${(res.targets || ['agy']).join(', ')})`,
    `  Target Directory : ${res.targetDir}`,
    `  Factory Config   : ${res.factoryConfigPath}`,
  ];
  if (res.pluginsJsonPath) {
    lines.push(`  Plugins Manifest : ${res.pluginsJsonPath}`);
  }
  if (res.claudeSettingsPath) {
    lines.push(`  Claude Settings  : ${res.claudeSettingsPath}`);
  }
  if (res.geminiSettingsPath) {
    lines.push(`  Gemini Settings  : ${res.geminiSettingsPath}`);
  }
  if (res.gitPreCommitPath) {
    lines.push(`  Git Pre-Commit   : ${res.gitPreCommitPath}`);
  }
  return lines.join('\n');
}

function formatPlanHuman(res) {
  if (res.slice) {
    return [
      `Slice        : ${res.slice.name}`,
      `Spec File    : ${res.specPath}`,
      `Allow Paths  : ${res.slice.allowPaths.join(', ')}`,
      `Verify Cmd   : ${res.slice.verifyCommand || '(none)'}`,
      `Description  : ${res.slice.description || '(none)'}`,
    ].join('\n');
  }
  const lines = [
    `Workspace  : ${res.cwd}`,
    `Spec File  : ${res.specPath || '(missing)'}`,
    `Valid      : ${res.valid ? 'YES' : 'NO'}`,
    `Slices     : ${(res.slices || []).join(', ') || '(none)'}`,
  ];
  if (res.errors && res.errors.length > 0) {
    lines.push('Errors:');
    for (const e of res.errors) {
      lines.push(`  - ${e}`);
    }
  }
  return lines.join('\n');
}

function formatLandHuman(res) {
  const lines = [
    `Worktree     : ${res.worktree}`,
    `Target Dir   : ${res.targetDir}`,
    `Allow Paths  : ${res.allowPaths.join(', ')}`,
    `Audit Status : ${res.audit.status} (${res.audit.findings.length} findings)`,
    `Landed Files : ${res.landedFiles.length}${res.dryRun ? ' (dry-run)' : ''}`,
    `Deleted Files: ${res.deletedFiles.length}${res.dryRun ? ' (dry-run)' : ''}`,
    `Verdict      : ${res.ok ? 'LANDED' : 'BLOCKED'}`,
  ];
  for (const f of res.landedFiles) {
    lines.push(`  + ${f}`);
  }
  for (const d of res.deletedFiles) {
    lines.push(`  - ${d}`);
  }
  return lines.join('\n');
}

function maybeAppendGithubSummary(markdownText, enabled) {
  if (!enabled) return;
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  try {
    fs.appendFileSync(summaryPath, `${markdownText}\n\n`, 'utf8');
  } catch {
    // Ignore summary write errors outside GitHub Actions
  }
}

/**
 * Executes the Software Factory CLI with the provided arguments.
 *
 * @param {string[]} [argv=process.argv.slice(2)]
 * @param {{ stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream }} [io]
 * @returns {number} Exit code (0 on success, non-zero on failure)
 */
export function runCli(
  argv = process.argv.slice(2),
  io = { stdout: process.stdout, stderr: process.stderr }
) {
  const args = normalizeArgv(argv);
  const out = (msg) => io.stdout.write(`${msg}\n`);
  const err = (msg) => io.stderr.write(`${msg}\n`);

  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        cwd: { type: 'string' },
        json: { type: 'boolean', default: false },
        format: { type: 'string' },
        'github-summary': { type: 'boolean', default: false },
        'require-tests': { type: 'boolean', default: false },
        'skip-docker': { type: 'boolean', default: false },
        base: { type: 'string' },
        all: { type: 'boolean', default: false },
        'allow-paths': { type: 'string' },
        slice: { type: 'string' },
        worktree: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        init: { type: 'boolean', default: false },
        routes: { type: 'string' },
        port: { type: 'string' },
        mode: { type: 'string', default: 'link' },
        target: { type: 'string', default: 'agy' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (parseErr) {
    err(`Error: ${parseErr.message}`);
    err('Run `agy-factory --help` for usage.');
    return 1;
  }

  const { values, positionals } = parsed;
  const subcommand = positionals[0];

  if (values.help || subcommand === 'help' || !subcommand) {
    if (!values.help && subcommand !== 'help' && !subcommand) {
      out(HELP_TEXT.trimEnd());
      return 0;
    }
    out(HELP_TEXT.trimEnd());
    return 0;
  }

  const effectiveCwd = values.cwd || positionals[1] || process.cwd();

  try {
    switch (subcommand) {
      case 'detect': {
        const result = detectProject(effectiveCwd);
        if (values.json) {
          out(JSON.stringify(result, null, 2));
        } else {
          out(formatDetectHuman(result));
        }
        return 0;
      }

      case 'plan': {
        const result = runPlan({
          cwd: effectiveCwd,
          init: Boolean(values.init),
          slice: values.slice || null,
        });
        if (values.json || values.format === 'json') {
          out(JSON.stringify(result, null, 2));
        } else {
          out(formatPlanHuman(result));
        }
        return result.ok ? 0 : 1;
      }

      case 'verify': {
        const receipt = runVerify({
          cwd: effectiveCwd,
          requireTests: values['require-tests'] ? true : undefined,
          skipDocker: Boolean(values['skip-docker']),
        });
        const fmt = values.json ? 'json' : (values.format || 'text').toLowerCase();
        const md = formatVerifyMarkdown(receipt);
        maybeAppendGithubSummary(md, Boolean(values['github-summary']));

        if (fmt === 'json') {
          out(JSON.stringify(receipt, null, 2));
        } else if (fmt === 'markdown' || fmt === 'md') {
          out(md);
        } else {
          out(formatVerifyHuman(receipt));
        }
        return receipt.ok ? 0 : 1;
      }

      case 'audit-diff': {
        const report = runAuditDiff({
          cwd: effectiveCwd,
          base: values.base || null,
          allFiles: Boolean(values.all),
          allowPaths: values['allow-paths'] || null,
          slice: values.slice || null,
        });
        const fmt = values.json ? 'json' : (values.format || 'text').toLowerCase();
        const md = formatAuditMarkdown(report);
        maybeAppendGithubSummary(md, Boolean(values['github-summary']));

        if (fmt === 'json') {
          out(JSON.stringify(report, null, 2));
        } else if (fmt === 'sarif') {
          out(formatAuditSarif(report));
        } else if (fmt === 'markdown' || fmt === 'md') {
          out(md);
        } else {
          out(formatAuditHuman(report));
        }
        return report.status === 'FLAGGED' ? 1 : 0;
      }

      case 'land': {
        const result = runLand({
          cwd: effectiveCwd,
          worktree: values.worktree,
          slice: values.slice || null,
          allowPaths: values['allow-paths'] || null,
          dryRun: Boolean(values['dry-run']),
          force: Boolean(values.force),
        });
        if (values.json || values.format === 'json') {
          out(JSON.stringify(result, null, 2));
        } else {
          out(formatLandHuman(result));
        }
        return result.ok ? 0 : 1;
      }

      case 'twin': {
        const routes = values.routes ? loadTwinRoutesFromFile(values.routes) : [];
        const port = values.port ? Number.parseInt(values.port, 10) : 0;
        const twin = createTwinServer({ routes });
        twin.listen(port).then((started) => {
          if (values.json || values.format === 'json') {
            out(JSON.stringify({ ok: true, url: started.url, port: started.port }));
          } else {
            out(`Digital Twin server listening at ${started.url}`);
          }
        });
        return 0;
      }

      case 'init': {
        const targetDir = positionals[1] || values.cwd || process.cwd();
        const result = runInit({
          targetDir,
          mode: values.mode || 'link',
          target: values.target || 'agy',
        });
        if (values.json || values.format === 'json') {
          out(JSON.stringify(result, null, 2));
        } else {
          out(formatInitHuman(result));
        }
        return 0;
      }

      default: {
        err(`Unknown command: "${subcommand}"`);
        err('Run `agy-factory --help` for usage.');
        return 1;
      }
    }
  } catch (runErr) {
    err(`Error: ${runErr.message}`);
    return 1;
  }
}

function isExecutedDirectly(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return (
      fs.realpathSync(process.argv[1]) ===
      fs.realpathSync(fileURLToPath(metaUrl))
    );
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(metaUrl));
  }
}

if (isExecutedDirectly(import.meta.url)) {
  const exitCode = runCli(process.argv.slice(2));
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}
