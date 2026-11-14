#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { detectProject } from '../lib/detect.js';
import { runVerify } from '../lib/verify.js';
import { runAuditDiff } from '../lib/audit-diff.js';
import { runInit } from '../lib/init.js';

const HELP_TEXT = `Antigravity Software Factory CLI (agy-factory)

Usage:
  agy-factory <command> [options]

Commands:
  detect                 Inventory project stack, Docker Compose, and scripts
  verify                 Run deterministic QA checks and write .factory/verify-receipt.json
  audit-diff             Scan git diff / untracked files for secrets and security sinks
  init [targetDir]       Link or copy the Software Factory plugin into a repository

Options:
  --cwd <dir>            Target working directory (defaults to current directory)
  --json                 Emit machine-readable JSON output
  --require-tests        Fail verify if no test suite passes (NOT_RUN is not PASS)
  --skip-docker          Skip docker compose validation during verify
  --base <ref>           Additional git base ref to diff against in audit-diff
  --all                  Scan all workspace files in audit-diff instead of git diff only
  --mode <link|copy>     Plugin installation mode for init (default: link)
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
  return [
    `Initialized Software Factory (${res.mode} mode)`,
    `  Target Directory : ${res.targetDir}`,
    `  Plugins Manifest : ${res.pluginsJsonPath}`,
    `  Factory Config   : ${res.factoryConfigPath}`,
  ].join('\n');
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
        'require-tests': { type: 'boolean', default: false },
        'skip-docker': { type: 'boolean', default: false },
        base: { type: 'string' },
        all: { type: 'boolean', default: false },
        mode: { type: 'string', default: 'link' },
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

      case 'verify': {
        const receipt = runVerify({
          cwd: effectiveCwd,
          requireTests: values['require-tests'] ? true : undefined,
          skipDocker: Boolean(values['skip-docker']),
        });
        if (values.json) {
          out(JSON.stringify(receipt, null, 2));
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
        });
        if (values.json) {
          out(JSON.stringify(report, null, 2));
        } else {
          out(formatAuditHuman(report));
        }
        return report.status === 'FLAGGED' ? 1 : 0;
      }

      case 'init': {
        const targetDir = positionals[1] || values.cwd || process.cwd();
        const result = runInit({
          targetDir,
          mode: values.mode || 'link',
        });
        if (values.json) {
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
