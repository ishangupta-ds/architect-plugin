#!/usr/bin/env node
// Fallback-path CLI: `architect-submit.mjs <plan-file>` (bin/ is on PATH once the
// plugin is installed). The skill instructs Claude to run this BEFORE calling
// ExitPlanMode whenever the primary (tool_input-carries-the-plan) gate path isn't
// available -- see DEV_NOTES.md #3. Compiles + checks the given plan file and
// writes a marker the PreToolUse hook can pick up (candidateMarkerKeys: session id
// if this process happens to have one, cwd always).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { candidateMarkerKeys, classifyResult, deriveSessionPlanId, formatReason, probeSessionId, resolveConfig, sha256Hex, submitAndCheck, writeMarker } from './architect-lib.mjs';

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('usage: architect-submit.mjs <plan-file.md>');
    process.exit(2);
  }

  const config = resolveConfig();
  if (config.mode === 'off') {
    console.log('Architect gate disabled (ARCHITECT_GATE=off) -- skipping submit.');
    process.exit(0);
  }
  if (!config.configured) {
    console.error('ARCHITECT_URL/ARCHITECT_TOKEN not set -- run `pnpm auth:token` against your Architect deployment and export both. See the architect-workflow skill.');
    process.exit(1);
  }

  const absolutePath = resolve(filePath);
  let markdown;
  try {
    markdown = readFileSync(absolutePath, 'utf8');
  } catch (err) {
    console.error(`could not read ${absolutePath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const cwd = process.cwd();
  const sessionId = probeSessionId();
  const planId = sessionId ? deriveSessionPlanId(sessionId) : `cc-${sha256Hex(cwd).slice(0, 12)}`;

  const result = await submitAndCheck(config, { markdown, planId });

  if (result.network) {
    console.error(formatReason(config, planId, { kind: 'network', detail: result.error }));
    process.exit(1);
  }
  if (!result.ok) {
    const kind = classifyResult(result);
    console.error(formatReason(config, planId, { kind, detail: `${result.stage} returned ${result.status}${result.json?.error ? ` ${result.json.error}` : ''}` }));
    process.exit(kind === 'server-unconfigured' ? 0 : 1);
  }

  const resolvedPlanId = result.planId ?? planId;
  writeMarker(candidateMarkerKeys({ sessionId, cwd }), {
    sessionId: sessionId ?? undefined,
    cwd,
    planId: resolvedPlanId,
    planHash: result.planHash,
    verdict: result.verdict,
    checkedAt: new Date().toISOString(),
  });

  const outcome = result.verdict.blocked ? { kind: 'blocked', verdict: result.verdict } : { kind: 'clean', verdict: result.verdict };
  console.log(formatReason(config, resolvedPlanId, outcome));
  process.exit(result.verdict.blocked ? 1 : 0);
}

main();
