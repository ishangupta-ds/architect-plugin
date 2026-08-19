#!/usr/bin/env node
// Shared logic for architect-gate.mjs, architect-submit.mjs, and
// architect-session-start.mjs. Zero dependencies (Node >=18 global fetch +
// node:crypto only) -- see DEV_NOTES.md for why this is Node, not bash/jq/python.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Reads the whole of stdin and JSON-parses it -- every Claude Code hook event
 * arrives this way. Returns {} if stdin is empty/unparseable rather than
 * throwing, so callers degrade gracefully instead of crashing the hook. */
export async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const VALID_MODES = new Set(['off', 'warn', 'enforce', 'enforce-approvals']);

/** ARCHITECT_GATE default: 'enforce' once a token is configured (setting a token
 * signals intent to use the gate for real), else 'warn' -- an unconfigured user
 * must never have plan mode silently bricked. 'enforce-approvals' (V11) is always
 * an explicit opt-in -- it never becomes a default, only ARCHITECT_GATE=enforce-approvals
 * selects it. */
export function resolveConfig(env = process.env) {
  const url = (env.ARCHITECT_URL || '').replace(/\/$/, '');
  const token = env.ARCHITECT_TOKEN || '';
  const workspace = env.ARCHITECT_WORKSPACE || '';
  const explicitMode = env.ARCHITECT_GATE;
  const mode = VALID_MODES.has(explicitMode) ? explicitMode : token ? 'enforce' : 'warn';
  return { url, token, workspace, mode, configured: Boolean(url && token) };
}

/** Session-stable planId so repeated ExitPlanMode attempts within one Claude Code
 * session REFINE the same plan (compile's planId precedence: body param wins,
 * an existing id refines using the stored graph as previousGraph) rather than
 * minting a fresh draft every retry. */
export function deriveSessionPlanId(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 12);
  return `cc-${safe || 'unknown'}`;
}

function apiPath(config, path) {
  if (config.workspace) return `${config.url}/api/w/${encodeURIComponent(config.workspace)}${path.slice('/api'.length)}`;
  return `${config.url}${path}`;
}

/** One request against Architect's REST API. Never throws on a non-2xx response
 * (callers branch on status); DOES throw/reject on a genuine network failure or
 * timeout so callers can tell "server said no" apart from "couldn't reach it". */
export async function architectRequest(config, method, path, body, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(apiPath(config, path), {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs compile -> check -> waivers against a plan's markdown, returning a
 * verdict. Distinguishes network/timeout failures (network:true) from real HTTP
 * error responses (status/json set) so the caller applies the right degradation
 * rule for each. */
export async function submitAndCheck(config, { markdown, planId }) {
  let compile;
  try {
    compile = await architectRequest(config, 'POST', '/api/plan/compile', { markdown, planId });
  } catch (err) {
    return { network: true, stage: 'compile', error: err instanceof Error ? err.message : String(err) };
  }
  if (compile.status !== 200) return { network: false, stage: 'compile', status: compile.status, json: compile.json };

  const resolvedPlanId = compile.json?.planId ?? planId;
  let check;
  try {
    check = await architectRequest(config, 'POST', `/api/plans/${encodeURIComponent(resolvedPlanId)}/check`, undefined);
  } catch (err) {
    return { network: true, stage: 'check', error: err instanceof Error ? err.message : String(err) };
  }
  if (check.status !== 200) return { network: false, stage: 'check', status: check.status, json: check.json };

  let waivers;
  try {
    waivers = await architectRequest(config, 'GET', `/api/plans/${encodeURIComponent(resolvedPlanId)}/waivers`, undefined);
  } catch (err) {
    return { network: true, stage: 'waivers', error: err instanceof Error ? err.message : String(err) };
  }
  // Bug fix (V11 plugin P1): a non-200 waivers response used to fall straight
  // through to `waivers.json?.waivers ?? []`, silently reading as "nothing
  // waived" -- turning a fully-waived plan into a false BLOCKED verdict instead
  // of surfacing the real failure. Treat it the same as a non-200 compile/check
  // response: short-circuit with the stage/status/json so the caller classifies
  // and reports it honestly.
  if (waivers.status !== 200) return { network: false, stage: 'waivers', status: waivers.status, json: waivers.json };
  const waivedIds = new Set((waivers.json?.waivers ?? []).map((w) => w.flagId));

  const verdict = computeVerdict(check.json?.report, check.json?.binderStats, waivedIds);
  return { ok: true, planId: resolvedPlanId, planHash: compile.json?.planHash, verdict };
}

export function computeVerdict(report, binderStats, waivedIds = new Set()) {
  const flags = report?.flags ?? [];
  const violations = flags.filter((f) => f.severity === 'violation' && !waivedIds.has(f.id));
  const risks = flags.filter((f) => f.severity === 'risk');
  const advisories = flags.filter((f) => f.severity === 'advisory');
  const binderIncomplete = Boolean(binderStats && binderStats.bound < binderStats.total);
  return { blocked: violations.length > 0, violations, risks, advisories, binderIncomplete, binderStats };
}

// ---- V11 plugin Part P3: enforce-approvals mode ----
//
// After a clean/waived verdict, when (and only when) ARCHITECT_GATE=enforce-approvals,
// the gate additionally consults the server's live review-approval gate (V11's
// gate-status snapshot -- approval state changes server-side, so this is never
// cached in the marker file the way the base verdict is). If the gate is
// unsatisfied and nobody has an open request at the plan's current hash yet, the
// gate auto-requests reviews on the caller's behalf before denying, so the human
// loop (approve in the UI or via Slack) can actually start.

/** GET .../gate-status, one-shot (no `wait` param -- this is a single poll, not a
 * long-poll; the caller is expected to re-invoke ExitPlanMode later, which
 * re-runs this check, rather than this script itself blocking). 5s timeout: the
 * PreToolUse hook budget is ~60s total and this is one more network call layered
 * on top of compile/check/waivers (each already up to 8s). */
export async function fetchGateStatus(config, planId, timeoutMs = 5000) {
  try {
    return await architectRequest(config, 'GET', `/api/plans/${encodeURIComponent(planId)}/gate-status`, undefined, timeoutMs);
  } catch (err) {
    return { network: true, error: err instanceof Error ? err.message : String(err) };
  }
}

/** POST .../reviews/request {auto:true} -- lets the server derive stakeholders
 * (CODEOWNERS/decisions/owner-fallback) rather than the plugin guessing logins. */
export async function requestReviewsAuto(config, planId, timeoutMs = 5000) {
  try {
    return await architectRequest(config, 'POST', `/api/plans/${encodeURIComponent(planId)}/reviews/request`, { auto: true }, timeoutMs);
  } catch (err) {
    return { network: true, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Pure: turns a gate-status result (+ optional review-request outcome) into one
 * of the four approval-gate states. No I/O, no fetch -- directly unit-testable
 * against hand-built fixtures, same discipline as computeVerdict. */
export function evaluateApprovalGate(gateStatusResult, requestOutcome) {
  if (gateStatusResult.network) return { kind: 'network', detail: gateStatusResult.error };
  // A 404 here means the plan itself is missing OR (far more likely in practice)
  // this server predates V11 and has no /gate-status route at all -- both read
  // as "can't tell you the approval state", which is an operator/deployment
  // problem, not a reason to block a clean plan.
  if (gateStatusResult.status === 404) return { kind: 'gate-status-unavailable' };
  const snapshot = gateStatusResult.json;
  if (gateStatusResult.status !== 200 || !snapshot?.reviewGate) {
    return { kind: 'gate-status-unavailable', detail: `gate-status returned ${gateStatusResult.status}` };
  }
  if (snapshot.reviewGate.satisfied) return { kind: 'approved', snapshot };
  if (requestOutcome?.noStakeholders) return { kind: 'awaiting-approval', snapshot, noStakeholders: true };
  return { kind: 'awaiting-approval', snapshot, requested: Boolean(requestOutcome?.requested) };
}

/** Orchestrates the fetch(es) evaluateApprovalGate needs: always fetches
 * gate-status; auto-requests reviews ONLY when the gate is unsatisfied AND
 * nothing is already pending at the current hash (`openAtCurrentHash === 0`) --
 * never re-requests on top of an existing open request. */
export async function checkApprovalGate(config, planId) {
  const gateStatusResult = await fetchGateStatus(config, planId);
  const preliminary = evaluateApprovalGate(gateStatusResult);
  if (preliminary.kind !== 'awaiting-approval' || preliminary.snapshot.reviewGate.openAtCurrentHash > 0) {
    return preliminary;
  }
  const reqResult = await requestReviewsAuto(config, planId);
  if (reqResult.network) return { kind: 'network', detail: reqResult.error };
  let requestOutcome;
  if (reqResult.status === 200) requestOutcome = { requested: true };
  else if (reqResult.status === 409 && reqResult.json?.error === 'REVIEW_ALREADY_REQUESTED') {
    // A request landed between our gate-status read and this POST (another
    // session, another retry) -- that's success, not a failure: treat it as
    // idempotent, exactly like the plan's own "409 = success" instruction.
    requestOutcome = { requested: false };
  } else if (reqResult.status === 409 && reqResult.json?.error === 'NO_STAKEHOLDERS_DERIVED') {
    requestOutcome = { noStakeholders: true };
  } else {
    requestOutcome = { requested: false, error: `reviews/request returned ${reqResult.status}${reqResult.json?.error ? ` ${reqResult.json.error}` : ''}` };
  }
  return evaluateApprovalGate(gateStatusResult, requestOutcome);
}

/** The single allow/deny decision point (V11 plugin P2 -- previously duplicated
 * inline in architect-gate.mjs's own classification table; moved here so it's
 * one unit-testable function shared by every caller). `approved` and
 * `gate-status-unavailable` always allow regardless of mode (the latter is an
 * operator/version problem, never a reason to block a clean plan);
 * `awaiting-approval` denies ONLY in `enforce-approvals` (plain `enforce` never
 * even computes this kind, since the approval-gate check only runs when the mode
 * is `enforce-approvals` -- see checkApprovalGate's caller in architect-gate.mjs). */
export function decideAllow(mode, kind) {
  if (kind === 'clean' || kind === 'server-unconfigured' || kind === 'approved' || kind === 'gate-status-unavailable') return true;
  if (kind === 'awaiting-approval') return mode !== 'enforce-approvals';
  if (mode !== 'enforce' && mode !== 'enforce-approvals') return true; // warn/off: never actually block
  return false; // enforce/enforce-approvals + blocked/network/bad-plan/other-error: deny
}

/** The one place error-response classification happens -- shared between the gate
 * (which decides allow/deny per class) and architect-submit.mjs (which just needs
 * a human-readable message). Classes match the plan's documented degradation
 * matrix, not a generic HTTP taxonomy. */
export function classifyResult(result) {
  if (result.network) return 'network';
  if (result.ok) return 'clean';
  const code = result.json?.error;
  if (result.status === 503 && code === 'PLANNER_UNAVAILABLE') return 'server-unconfigured';
  if (result.status === 400 && code === 'NO_CODE_SNAPSHOT') return 'server-unconfigured';
  if (result.status === 400 && code === 'INVALID_FRONTMATTER') return 'bad-plan';
  if (result.status === 502 && code === 'PLANNER_CALL_FAILED') return 'bad-plan';
  return 'other-error';
}

export function formatReason(config, planId, outcome) {
  if (outcome.kind === 'clean') {
    const { verdict } = outcome;
    const incomplete = verdict.binderIncomplete ? ` INCOMPLETE (binder ${verdict.binderStats.bound}/${verdict.binderStats.total} bound -- unbound nodes were not judged).` : '';
    return `Architect: 0 violations, ${verdict.risks.length} risk(s), ${verdict.advisories.length} advisory(ies) (planId ${planId}).${incomplete}`;
  }
  if (outcome.kind === 'blocked') {
    const { verdict } = outcome;
    const lines = verdict.violations.map((f) => `- [${f.code}] ${f.message}`).join('\n');
    const incomplete = verdict.binderIncomplete ? `\nNote: binder ${verdict.binderStats.bound}/${verdict.binderStats.total} bound -- report is INCOMPLETE, not clean.` : '';
    return `Architect blocked this plan (planId ${planId}) -- ${verdict.violations.length} unwaived violation(s):\n${lines}${incomplete}\nFix the plan and retry (same session refines this plan), or waive via POST /api/plans/${planId}/waive with a substantive reason, then retry.`;
  }
  if (outcome.kind === 'network') {
    return `Architect (${config.url || '<unset ARCHITECT_URL>'}) is unreachable: ${outcome.detail}. Retry, or export ARCHITECT_GATE=warn to bypass while this is investigated.`;
  }
  if (outcome.kind === 'server-unconfigured') {
    return `Architect's server isn't ready to judge this plan yet (${outcome.detail}) -- this is a deployment/configuration issue, not a problem with the plan. Allowing.`;
  }
  if (outcome.kind === 'bad-plan') {
    return `Architect could not compile this plan (${outcome.detail}) -- revise the plan markdown and retry.`;
  }
  // V11 plugin P3 (enforce-approvals mode) -- these three kinds are only ever
  // produced when ARCHITECT_GATE=enforce-approvals; see checkApprovalGate.
  if (outcome.kind === 'approved') {
    const rg = outcome.snapshot.reviewGate;
    return `Architect: 0 violations (planId ${planId}) and the review-approval gate is satisfied (${rg.have} approved, mode ${rg.mode}).`;
  }
  if (outcome.kind === 'gate-status-unavailable') {
    const detail = outcome.detail ? ` (${outcome.detail})` : '';
    return `Architect: plan is clean (planId ${planId}), but this server doesn't support the review-approval gate-status route yet${detail} -- likely a pre-V11 deployment. Allowing without an approval check; upgrade the server, or set ARCHITECT_GATE=enforce instead of enforce-approvals until then.`;
  }
  if (outcome.kind === 'awaiting-approval') {
    const rg = outcome.snapshot.reviewGate;
    const fingerprint = outcome.snapshot.fingerprint;
    let statusNote;
    if (outcome.noStakeholders) {
      statusNote = `No reviewers could be auto-derived (no CODEOWNERS/decision/owner match) -- ask the user who should review this plan, then POST /api/plans/${planId}/reviews/request {from:["login", ...]}.`;
    } else if (outcome.requested) {
      statusNote = 'Review request(s) were just sent.';
    } else {
      statusNote = `${rg.openAtCurrentHash} open request(s) already pending.`;
    }
    return `Architect: plan is clean (planId ${planId}) but awaiting reviewer approval (${rg.have}/${rg.requiredApprovals || rg.openAtCurrentHash || 1} approved, mode ${rg.mode}). ${statusNote} Poll \`GET /api/plans/${planId}/gate-status?wait=25&since=${fingerprint}\` until \`reviewGate.satisfied\` is true, then retry ExitPlanMode. Never approve your own plan.`;
  }
  // Anything else is a real gap in this classification -- name the kind
  // explicitly rather than folding it into a generic message that would hide
  // which branch was actually hit (V11 plugin P2).
  return `Architect returned an unexpected error (kind: ${outcome.kind}${outcome.detail ? `, detail: ${outcome.detail}` : ''}) -- export ARCHITECT_GATE=warn to bypass while this is investigated.`;
}

// ---- Marker-file fallback protocol (used when tool_input carries no plan text) ----
//
// Correlating "the check architect-submit.mjs just ran" with "the ExitPlanMode
// call the PreToolUse hook is now gating" is genuinely uncertain: the hook's
// stdin JSON confirmed carries session_id + cwd, but whether a plain Bash-tool
// subprocess (which is how the skill invokes architect-submit.mjs) has that same
// session id available via an env var is NOT confirmed by the plugin docs. So
// this uses TWO correlation keys, strongest-available wins:
//   - session-<id>  -- used only if a session id was actually obtainable at
//     write time (a few candidate env var names are tried, none guaranteed)
//   - cwd-<hash>     -- always available on both sides (process.cwd() at write
//     time; the hook's own `cwd` field at read time) -- the honest fallback.
// A marker is only trusted if BOTH fresh (<=15min) AND matches on session id OR
// cwd against what the READER independently knows -- never on the key alone.

export function markerDir() {
  const base = process.env.CLAUDE_PLUGIN_DATA || join(process.env.HOME || '.', '.architect-plugin-data');
  return join(base, 'gate-state');
}

/** Best-effort session id for a plain (non-hook) script -- none of these are
 * confirmed to be set; absence is expected and handled (falls through to the
 * cwd-only key). */
export function probeSessionId(env = process.env) {
  return env.CLAUDE_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || undefined;
}

export function candidateMarkerKeys({ sessionId, cwd }) {
  const keys = [];
  if (sessionId) keys.push(`session-${deriveSessionPlanId(sessionId)}`);
  if (cwd) keys.push(`cwd-${sha256Hex(cwd).slice(0, 16)}`);
  return keys;
}

function markerPathForKey(key) {
  return join(markerDir(), `${key}.json`);
}

export function writeMarker(keys, marker) {
  const dir = markerDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  for (const key of keys) writeFileSync(markerPathForKey(key), JSON.stringify(marker), 'utf8');
}

/** Tries each candidate key in order; a hit is trusted only if fresh AND its
 * recorded sessionId or cwd matches what the caller independently knows (never
 * trusted on the filename match alone). Every failure mode -- missing, stale,
 * unparseable, mismatched -- collapses to "no fresh check found", never a crash. */
export function readFreshMarker(keys, { sessionId, cwd } = {}, maxAgeMs = 15 * 60 * 1000) {
  for (const key of keys) {
    const path = markerPathForKey(key);
    if (!existsSync(path)) continue;
    let marker;
    try {
      marker = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    // Bug fix (V11 plugin P1): Date.parse on a missing/malformed checkedAt
    // returns NaN, and `Date.now() - NaN` is NaN, which fails a `> maxAgeMs`
    // comparison silently -- a corrupt or hand-edited marker used to read as
    // "fresh" instead of being rejected. Require a finite age explicitly.
    const age = Date.now() - Date.parse(marker.checkedAt);
    if (!Number.isFinite(age) || age > maxAgeMs) continue;
    if (sessionId && marker.sessionId === sessionId) return marker;
    if (cwd && marker.cwd === cwd) return marker;
  }
  return undefined;
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function log(...args) {
  // Diagnostics only -- NEVER write to stdout from here, PreToolUse's stdout is
  // reserved for the single JSON control-output line.
  console.error('[architect]', ...args);
}
