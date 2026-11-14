#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../plugins/agy-software-factory/bin/agy-factory.js';

export { runCli };

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
