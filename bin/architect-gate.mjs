#!/usr/bin/env node
// PreToolUse(ExitPlanMode) gate + PostToolUse(ExitPlanMode) diagnostics.
//
// Ships BOTH payload paths (see DEV_NOTES.md #3, unconfirmed which Claude Code
// actually exercises): if the PreToolUse tool_input carries the plan text
// directly, check it inline; otherwise fall back to a session-scoped marker file
// written by architect-submit.mjs (the skill instructs Claude to run that first
// when the primary path yields no text).
import { candidateMarkerKeys, deriveSessionPlanId, formatReason, log, markerDir, readFreshMarker, readStdinJson, resolveConfig, submitAndCheck } from './architect-lib.mjs';
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

function emit(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
    }),
  );
  process.exit(0);
}

async function runPost(input) {
  // Diagnostic-only -- PostToolUse cannot block. Records the observed
  // tool_response shape when ARCHITECT_DEBUG=1, to help resolve DEV_NOTES.md #3
  // from real sessions without adding noise for everyday use.
  if (process.env.ARCHITECT_DEBUG !== '1') return;
  try {
    const dir = markerDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'post-tool-use-debug.jsonl'), JSON.stringify({ at: new Date().toISOString(), input }) + '\n', 'utf8');
  } catch (err) {
    log('post-diagnostic write failed (non-fatal):', err instanceof Error ? err.message : String(err));
  }
}

function decideAllow(mode, kind) {
  if (kind === 'clean' || kind === 'server-unconfigured') return true;
  if (mode !== 'enforce') return true; // warn/off: never actually block
  return false; // enforce + blocked/network/bad-plan/other-error: deny
}

async function runPre(input) {
  const config = resolveConfig();
  const sessionId = input.session_id || 'unknown';
  const cwd = input.cwd || process.cwd();
  const planId = deriveSessionPlanId(sessionId);

  if (config.mode === 'off') {
    emit('allow', 'Architect gate disabled (ARCHITECT_GATE=off).');
    return;
  }
  if (!config.configured) {
    emit('allow', 'Architect gate not configured (ARCHITECT_URL/ARCHITECT_TOKEN unset) -- allowing. See the architect-workflow skill for setup.');
    return;
  }

  const inlinePlan = typeof input.tool_input?.plan === 'string' ? input.tool_input.plan.trim() : '';

  if (inlinePlan) {
    const result = await submitAndCheck(config, { markdown: inlinePlan, planId });
    handleResult(config, planId, result);
    return;
  }

  // Fallback: no plan text in tool_input -- consult the marker architect-submit.mjs
  // may have written before this ExitPlanMode call (session-keyed if a session id
  // was obtainable when it ran, cwd-keyed as the always-available fallback).
  const marker = readFreshMarker(candidateMarkerKeys({ sessionId, cwd }), { sessionId, cwd });
  if (!marker) {
    if (config.mode === 'enforce') {
      emit('deny', `No fresh Architect check found for this session (planId ${planId}) -- run \`architect-submit.mjs <plan-file>\` on your plan first, then retry. Or export ARCHITECT_GATE=warn to bypass while investigating.`);
    } else {
      emit('allow', `Architect: no plan text available to check (planId ${planId}) -- gate skipped in warn mode.`);
    }
    return;
  }

  const outcome = marker.verdict.blocked ? { kind: 'blocked', verdict: marker.verdict } : { kind: 'clean', verdict: marker.verdict };
  const allow = decideAllow(config.mode, outcome.kind);
  emit(allow ? 'allow' : 'deny', formatReason(config, marker.planId ?? planId, outcome));
}

function handleResult(config, planId, result) {
  if (result.network) {
    const outcome = { kind: 'network', detail: result.error };
    emit(decideAllow(config.mode, 'network') ? 'allow' : 'deny', formatReason(config, planId, outcome));
    return;
  }
  if (result.ok) {
    const outcome = result.verdict.blocked ? { kind: 'blocked', verdict: result.verdict } : { kind: 'clean', verdict: result.verdict };
    const allow = decideAllow(config.mode, outcome.kind);
    emit(allow ? 'allow' : 'deny', formatReason(config, result.planId ?? planId, outcome));
    return;
  }
  // Non-2xx HTTP response from compile/check/waivers.
  const code = result.json?.error;
  const detail = `${result.stage} returned ${result.status}${code ? ` ${code}` : ''}`;
  let kind = 'other-error';
  if (result.status === 503 && code === 'PLANNER_UNAVAILABLE') kind = 'server-unconfigured';
  else if (result.status === 400 && code === 'NO_CODE_SNAPSHOT') kind = 'server-unconfigured';
  else if (result.status === 400 && code === 'INVALID_FRONTMATTER') kind = 'bad-plan';
  else if (result.status === 502 && code === 'PLANNER_CALL_FAILED') kind = 'bad-plan';
  emit(decideAllow(config.mode, kind) ? 'allow' : 'deny', formatReason(config, planId, { kind, detail }));
}

async function main() {
  const input = await readStdinJson();
  const isPost = process.argv.includes('--post');
  if (isPost) {
    await runPost(input);
    process.exit(0);
  }
  try {
    await runPre(input);
  } catch (err) {
    // A bug in this script must never permanently brick plan mode -- fail open
    // with the error surfaced, same posture as an unreachable server.
    log('unexpected error, failing open:', err instanceof Error ? err.stack : String(err));
    emit('allow', `Architect gate hit an internal error and is allowing this plan through: ${err instanceof Error ? err.message : String(err)}`);
  }
}

main();
