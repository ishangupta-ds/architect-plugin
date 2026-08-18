#!/usr/bin/env node
// Cheap, dependency-free sanity check for this plugin's manifests + scripts.
// Run via `node bin/validate.mjs` or the CI workflow. Catches the common
// shipping breaks: malformed JSON, and a bin script with a syntax error.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let failed = false;

function checkJson(relPath) {
  const full = join(root, relPath);
  try {
    JSON.parse(readFileSync(full, 'utf8'));
    console.log(`ok   ${relPath}`);
  } catch (err) {
    failed = true;
    console.error(`FAIL ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function checkScript(relPath) {
  const full = join(root, relPath);
  try {
    execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
    console.log(`ok   ${relPath}`);
  } catch (err) {
    failed = true;
    const stderr = err && typeof err === 'object' && 'stderr' in err ? String(err.stderr) : String(err);
    console.error(`FAIL ${relPath}: ${stderr}`);
  }
}

checkJson('.claude-plugin/plugin.json');
checkJson('.claude-plugin/marketplace.json');
checkJson('.mcp.json');
checkJson('hooks/hooks.json');

for (const script of ['bin/architect-lib.mjs', 'bin/architect-gate.mjs', 'bin/architect-submit.mjs', 'bin/architect-session-start.mjs', 'bin/validate.mjs']) {
  checkScript(script);
}

if (failed) {
  console.error('\nvalidate.mjs: FAILED');
  process.exit(1);
}
console.log('\nvalidate.mjs: all checks passed');
