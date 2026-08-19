#!/usr/bin/env node
// PreToolUse(ExitPlanMode) gate + PostToolUse(ExitPlanMode) diagnostics.
//
// Ships BOTH payload paths (see DEV_NOTES.md #3, unconfirmed which Claude Code
// actually exercises): if the PreToolUse tool_input carries the plan text
// directly, check it inline; otherwise fall back to a session-scoped marker file
// written by architect-submit.mjs (the skill instructs Claude to run that first
// when the primary path yields no text).
import { candidateMarkerKeys, checkApprovalGate, classifyResult, decideAllow, deriveSessionPlanId, formatReason, log, markerDir, readFreshMarker, readStdinJson, resolveConfig, submitAndCheck } from './architect-lib.mjs';
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

/** V11 plugin P3: after a clean/waived base outcome, when the mode is
 * `enforce-approvals`, additionally consult the live review-approval gate and
 * let it override the outcome (clean -> approved/awaiting-approval/
 * gate-status-unavailable/network). Every other mode, and every non-clean base
 * outcome, passes through completely unchanged -- this is the one place that
 * behavior differs from plain `enforce`, and it's opt-in only. */
async function finalizeOutcome(config, planId, baseOutcome) {
  if (baseOutcome.kind !== 'clean' || config.mode !== 'enforce-approvals') return baseOutcome;
  return await checkApprovalGate(config, planId);
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
    await handleResult(config, planId, result);
    return;
  }

  // Fallback: no plan text in tool_input -- consult the marker architect-submit.mjs
  // may have written before this ExitPlanMode call (session-keyed if a session id
  // was obtainable when it ran, cwd-keyed as the always-available fallback).
  const marker = readFreshMarker(candidateMarkerKeys({ sessionId, cwd }), { sessionId, cwd });
  if (!marker) {
    if (config.mode === 'enforce' || config.mode === 'enforce-approvals') {
      emit('deny', `No fresh Architect check found for this session (planId ${planId}) -- run \`architect-submit.mjs <plan-file>\` on your plan first, then retry. Or export ARCHITECT_GATE=warn to bypass while investigating.`);
    } else {
      emit('allow', `Architect: no plan text available to check (planId ${planId}) -- gate skipped in warn mode.`);
    }
    return;
  }

  const baseOutcome = marker.verdict.blocked ? { kind: 'blocked', verdict: marker.verdict } : { kind: 'clean', verdict: marker.verdict };
  const resolvedPlanId = marker.planId ?? planId;
  const outcome = await finalizeOutcome(config, resolvedPlanId, baseOutcome);
  const allow = decideAllow(config.mode, outcome.kind);
  emit(allow ? 'allow' : 'deny', formatReason(config, resolvedPlanId, outcome));
}

async function handleResult(config, planId, result) {
  if (result.network) {
    const outcome = { kind: 'network', detail: result.error };
    emit(decideAllow(config.mode, 'network') ? 'allow' : 'deny', formatReason(config, planId, outcome));
    return;
  }
  if (result.ok) {
    const resolvedPlanId = result.planId ?? planId;
    const baseOutcome = result.verdict.blocked ? { kind: 'blocked', verdict: result.verdict } : { kind: 'clean', verdict: result.verdict };
    const outcome = await finalizeOutcome(config, resolvedPlanId, baseOutcome);
    const allow = decideAllow(config.mode, outcome.kind);
    emit(allow ? 'allow' : 'deny', formatReason(config, resolvedPlanId, outcome));
    return;
  }
  // Non-2xx HTTP response from compile/check/waivers. classifyResult is the ONE
  // place this classification table lives (V11 plugin P2 -- this used to be a
  // second, hand-duplicated copy of architect-lib.mjs's own table, which could
  // silently drift from it).
  const code = result.json?.error;
  const detail = `${result.stage} returned ${result.status}${code ? ` ${code}` : ''}`;
  const kind = classifyResult(result);
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
