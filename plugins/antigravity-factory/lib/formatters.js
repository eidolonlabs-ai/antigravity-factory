import fs from 'node:fs';

const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(
      fs.readFileSync(new URL('../plugin.json', import.meta.url), 'utf8')
    ).version || '1.1.0';
  } catch {
    return '1.1.0';
  }
})();

const SARIF_RULES = {
  'hardcoded-secret': {
    id: 'hardcoded-secret',
    name: 'HardcodedSecret',
    shortDescription: { text: 'Hardcoded secret, credential, or private key material' },
  },
  'dangerous-exec': {
    id: 'dangerous-exec',
    name: 'DangerousExec',
    shortDescription: { text: 'Dynamic code execution or unparameterized shell command interpolation' },
  },
  'xss-sink': {
    id: 'xss-sink',
    name: 'XssSink',
    shortDescription: { text: 'Unescaped HTML DOM sink' },
  },
  'sql-interpolation': {
    id: 'sql-interpolation',
    name: 'SqlInterpolation',
    shortDescription: { text: 'Unparameterized string interpolation inside SQL statement' },
  },
  'slice-boundary-violation': {
    id: 'slice-boundary-violation',
    name: 'SliceBoundaryViolation',
    shortDescription: { text: 'Modified file is outside assigned slice ownership boundaries' },
  },
};

export function formatVerifyMarkdown(receipt) {
  const badge = receipt.ok ? 'PASS' : 'FAIL';
  const lines = [
    `## Antigravity Factory Verification: ${badge}`,
    '',
    `- **Workspace**: \`${receipt.cwd}\``,
    `- **Digest**: \`${receipt.digest.slice(0, 16)}...\``,
    `- **Summary**: **${receipt.summary.pass}** PASS, **${receipt.summary.fail}** FAIL, **${receipt.summary.notRun}** NOT_RUN${receipt.requireTests ? ' (`--require-tests`)' : ''}`,
    '',
    '| Status | Component | Category | Duration | Details |',
    '| :--- | :--- | :--- | :--- | :--- |',
  ];

  for (const check of receipt.checks) {
    const timeStr = check.status === 'NOT_RUN' ? '-' : `${check.durationMs}ms`;
    const details = String(check.command || check.output || '')
      .replace(/\|/g, '\\|')
      .replace(/\r?\n/g, ' ')
      .slice(0, 140);
    lines.push(
      `| **${check.status}** | \`${check.component}\` | \`${check.category}\` | ${timeStr} | ${details} |`
    );
  }

  return lines.join('\n');
}

export function formatAuditMarkdown(report) {
  const lines = [
    `## Antigravity Factory Diff & Security Audit: ${report.status}`,
    '',
    `- **Workspace**: \`${report.cwd}\``,
    `- **Files Scanned**: **${report.filesScanned}**`,
    `- **Findings**: **${report.findings.length}**`,
  ];

  if (report.findings.length > 0) {
    lines.push('');
    lines.push('| Severity | Rule | Location | Message |');
    lines.push('| :--- | :--- | :--- | :--- |');
    for (const f of report.findings) {
      const msg = String(f.message || '').replace(/\|/g, '\\|');
      lines.push(
        `| **${f.severity.toUpperCase()}** | \`${f.rule}\` | \`${f.file}:${f.line}\` | ${msg} |`
      );
    }
  }

  return lines.join('\n');
}

export function formatAuditSarif(report) {
  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'agy-factory',
            informationUri: 'https://github.com/eidolonlabs-ai/antigravity-factory',
            version: PLUGIN_VERSION,
            rules: Object.values(SARIF_RULES),
          },
        },
        results: report.findings.map((f) => ({
          ruleId: f.rule,
          level: f.severity === 'high' ? 'error' : 'warning',
          message: {
            text: f.message,
          },
          locations: [
            {
              physicalLocation: {
                artifactLocation: {
                  uri: f.file,
                },
                region: {
                  startLine: Number.isInteger(f.line) && f.line > 0 ? f.line : 1,
                },
              },
            },
          ],
        })),
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}
