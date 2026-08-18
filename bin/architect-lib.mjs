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

/** ARCHITECT_GATE default: 'enforce' once a token is configured (setting a token
 * signals intent to use the gate for real), else 'warn' -- an unconfigured user
 * must never have plan mode silently bricked. */
export function resolveConfig(env = process.env) {
  const url = (env.ARCHITECT_URL || '').replace(/\/$/, '');
  const token = env.ARCHITECT_TOKEN || '';
  const workspace = env.ARCHITECT_WORKSPACE || '';
  const explicitMode = env.ARCHITECT_GATE;
  const mode = explicitMode === 'off' || explicitMode === 'warn' || explicitMode === 'enforce' ? explicitMode : token ? 'enforce' : 'warn';
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
  return `Architect returned an unexpected error (${outcome.detail}) -- export ARCHITECT_GATE=warn to bypass while this is investigated.`;
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
    if (Date.now() - Date.parse(marker.checkedAt) > maxAgeMs) continue;
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
