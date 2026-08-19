import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  candidateMarkerKeys,
  checkApprovalGate,
  classifyResult,
  computeVerdict,
  decideAllow,
  deriveSessionPlanId,
  evaluateApprovalGate,
  formatReason,
  probeSessionId,
  readFreshMarker,
  resolveConfig,
  sha256Hex,
  submitAndCheck,
  writeMarker,
} from '../bin/architect-lib.mjs';

describe('resolveConfig', () => {
  test('defaults to warn mode when no token is set', () => {
    const config = resolveConfig({ ARCHITECT_URL: 'https://example.test' });
    assert.equal(config.mode, 'warn');
    assert.equal(config.configured, false);
  });

  test('defaults to enforce mode once a token is set', () => {
    const config = resolveConfig({ ARCHITECT_URL: 'https://example.test', ARCHITECT_TOKEN: 'architect_x' });
    assert.equal(config.mode, 'enforce');
    assert.equal(config.configured, true);
  });

  test('an explicit ARCHITECT_GATE value always wins over the default', () => {
    const config = resolveConfig({ ARCHITECT_URL: 'https://example.test', ARCHITECT_TOKEN: 'architect_x', ARCHITECT_GATE: 'off' });
    assert.equal(config.mode, 'off');
  });

  test('an invalid ARCHITECT_GATE value falls back to the token-based default rather than crashing', () => {
    const config = resolveConfig({ ARCHITECT_TOKEN: 'architect_x', ARCHITECT_GATE: 'bogus' });
    assert.equal(config.mode, 'enforce');
  });

  test('ARCHITECT_GATE=enforce-approvals is a valid explicit mode (V11 P3) and is never a default', () => {
    const explicit = resolveConfig({ ARCHITECT_URL: 'https://example.test', ARCHITECT_TOKEN: 'architect_x', ARCHITECT_GATE: 'enforce-approvals' });
    assert.equal(explicit.mode, 'enforce-approvals');
    const tokenOnly = resolveConfig({ ARCHITECT_URL: 'https://example.test', ARCHITECT_TOKEN: 'architect_x' });
    assert.equal(tokenOnly.mode, 'enforce');
  });

  test('strips a trailing slash from ARCHITECT_URL', () => {
    const config = resolveConfig({ ARCHITECT_URL: 'https://example.test/' });
    assert.equal(config.url, 'https://example.test');
  });
});

describe('deriveSessionPlanId', () => {
  test('sanitizes non-alphanumeric characters (keeping hyphens) and caps length', () => {
    // hyphens survive the [^a-zA-Z0-9-] strip; underscores/bangs don't --
    // 'abc-DEF_123!!!...' -> 'abc-DEF123extra...' -> first 12 chars.
    assert.equal(deriveSessionPlanId('abc-DEF_123!!!extra-long-id-that-should-be-truncated'), 'cc-abc-DEF123ex');
  });

  test('falls back to "unknown" for a missing/empty session id', () => {
    assert.equal(deriveSessionPlanId(undefined), 'cc-unknown');
    assert.equal(deriveSessionPlanId(''), 'cc-unknown');
  });

  test('is deterministic for the same input', () => {
    assert.equal(deriveSessionPlanId('sess-123'), deriveSessionPlanId('sess-123'));
  });
});

describe('computeVerdict', () => {
  const report = {
    flags: [
      { id: 'f1', severity: 'violation', code: 'V1', message: 'bad' },
      { id: 'f2', severity: 'violation', code: 'V2', message: 'also bad' },
      { id: 'f3', severity: 'risk', code: 'R1', message: 'meh' },
      { id: 'f4', severity: 'advisory', code: 'A1', message: 'fyi' },
    ],
  };

  test('blocks when an unwaived violation is present', () => {
    const verdict = computeVerdict(report, { total: 4, bound: 4 }, new Set());
    assert.equal(verdict.blocked, true);
    assert.equal(verdict.violations.length, 2);
    assert.equal(verdict.risks.length, 1);
    assert.equal(verdict.advisories.length, 1);
  });

  test('does not block once every violation is waived', () => {
    const verdict = computeVerdict(report, { total: 4, bound: 4 }, new Set(['f1', 'f2']));
    assert.equal(verdict.blocked, false);
    assert.equal(verdict.violations.length, 0);
  });

  test('flags binder incompleteness when bound < total', () => {
    const verdict = computeVerdict({ flags: [] }, { total: 10, bound: 7 });
    assert.equal(verdict.binderIncomplete, true);
  });

  test('handles a missing report/binderStats without throwing', () => {
    const verdict = computeVerdict(undefined, undefined);
    assert.equal(verdict.blocked, false);
    assert.equal(verdict.binderIncomplete, false);
  });
});

describe('classifyResult', () => {
  test('classifies a network failure', () => {
    assert.equal(classifyResult({ network: true }), 'network');
  });

  test('classifies a clean ok result', () => {
    assert.equal(classifyResult({ ok: true, verdict: { blocked: false } }), 'clean');
  });

  test('classifies PLANNER_UNAVAILABLE and NO_CODE_SNAPSHOT as server-unconfigured', () => {
    assert.equal(classifyResult({ status: 503, json: { error: 'PLANNER_UNAVAILABLE' } }), 'server-unconfigured');
    assert.equal(classifyResult({ status: 400, json: { error: 'NO_CODE_SNAPSHOT' } }), 'server-unconfigured');
  });

  test('classifies INVALID_FRONTMATTER and PLANNER_CALL_FAILED as bad-plan', () => {
    assert.equal(classifyResult({ status: 400, json: { error: 'INVALID_FRONTMATTER' } }), 'bad-plan');
    assert.equal(classifyResult({ status: 502, json: { error: 'PLANNER_CALL_FAILED' } }), 'bad-plan');
  });

  test('falls back to other-error for anything unrecognized', () => {
    assert.equal(classifyResult({ status: 500, json: { error: 'WHATEVER' } }), 'other-error');
  });
});

describe('formatReason', () => {
  const config = { url: 'https://example.test' };

  test('a blocked outcome lists every violation code and message', () => {
    const verdict = { violations: [{ code: 'V1', message: 'boundary crossed' }], risks: [], advisories: [], binderIncomplete: false };
    const reason = formatReason(config, 'cc-abc', { kind: 'blocked', verdict });
    assert.match(reason, /V1/);
    assert.match(reason, /boundary crossed/);
    assert.match(reason, /cc-abc/);
  });

  test('a clean outcome reports risk/advisory counts and notes binder incompleteness', () => {
    const verdict = { violations: [], risks: [{ id: 'r1' }], advisories: [], binderIncomplete: true, binderStats: { bound: 3, total: 5 } };
    const reason = formatReason(config, 'cc-abc', { kind: 'clean', verdict });
    assert.match(reason, /1 risk/);
    assert.match(reason, /INCOMPLETE/);
    assert.match(reason, /3\/5/);
  });

  test('a network outcome names the unreachable URL and the bypass escape hatch', () => {
    const reason = formatReason(config, 'cc-abc', { kind: 'network', detail: 'timeout' });
    assert.match(reason, /example\.test/);
    assert.match(reason, /ARCHITECT_GATE=warn/);
  });

  test('a server-unconfigured outcome frames it as a deployment issue, not a plan problem', () => {
    const reason = formatReason(config, 'cc-abc', { kind: 'server-unconfigured', detail: 'no code snapshot' });
    assert.match(reason, /not a problem with the plan/);
  });

  test('an approved outcome (V11 P3) reports the review-gate as satisfied', () => {
    const reason = formatReason(config, 'cc-abc', { kind: 'approved', snapshot: { reviewGate: { have: 2, mode: 'all-requested' } } });
    assert.match(reason, /satisfied/);
    assert.match(reason, /2 approved/);
  });

  test('a gate-status-unavailable outcome (V11 P3) frames it as a server/version issue, never a plan problem', () => {
    const reason = formatReason(config, 'cc-abc', { kind: 'gate-status-unavailable' });
    assert.match(reason, /pre-V11/);
    assert.match(reason, /ARCHITECT_GATE=enforce\b/);
  });

  test('an awaiting-approval outcome (V11 P3) gives the exact poll loop, including the fingerprint and gate-status URL', () => {
    const snapshot = { reviewGate: { have: 0, requiredApprovals: 1, openAtCurrentHash: 1, mode: 'count' }, fingerprint: 'fp123' };
    const reason = formatReason(config, 'cc-abc', { kind: 'awaiting-approval', snapshot, requested: true });
    assert.match(reason, /gate-status\?wait=25&since=fp123/);
    assert.match(reason, /reviewGate\.satisfied/);
    assert.match(reason, /just sent/);
    assert.match(reason, /Never approve your own plan/);
  });

  test('an awaiting-approval outcome with no derivable stakeholders tells the caller to name reviewers explicitly', () => {
    const snapshot = { reviewGate: { have: 0, requiredApprovals: 1, openAtCurrentHash: 0, mode: 'count' }, fingerprint: 'fp123' };
    const reason = formatReason(config, 'cc-abc', { kind: 'awaiting-approval', snapshot, noStakeholders: true });
    assert.match(reason, /No reviewers could be auto-derived/);
    assert.match(reason, /reviews\/request \{from:/);
  });

  test('an unrecognized kind names itself explicitly rather than being folded into a generic message silently', () => {
    const reason = formatReason(config, 'cc-abc', { kind: 'totally-new-kind', detail: 'something odd' });
    assert.match(reason, /totally-new-kind/);
    assert.match(reason, /something odd/);
  });
});

describe('submitAndCheck (mocked fetch)', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function jsonResponse(status, body) {
    return { status, text: async () => JSON.stringify(body) };
  }

  test('a clean compile+check+waivers round trip returns ok:true with a computed verdict', async () => {
    let call = 0;
    globalThis.fetch = async (url) => {
      call += 1;
      if (call === 1) return jsonResponse(200, { planId: 'cc-abc', planHash: 'hash1' });
      if (call === 2) return jsonResponse(200, { report: { flags: [] }, binderStats: { total: 0, bound: 0 } });
      return jsonResponse(200, { waivers: [] });
    };
    const result = await submitAndCheck({ url: 'https://example.test', token: 't' }, { markdown: '# plan', planId: 'cc-abc' });
    assert.equal(result.ok, true);
    assert.equal(result.verdict.blocked, false);
  });

  test('a non-200 compile response short-circuits before check/waivers ever run', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return jsonResponse(503, { error: 'PLANNER_UNAVAILABLE' });
    };
    const result = await submitAndCheck({ url: 'https://example.test', token: 't' }, { markdown: '# plan', planId: 'cc-abc' });
    assert.equal(result.ok, undefined);
    assert.equal(result.stage, 'compile');
    assert.equal(calls, 1);
  });

  test('a thrown/aborted fetch is reported as a network failure, not an unhandled rejection', async () => {
    globalThis.fetch = async () => {
      throw new Error('fetch failed: ECONNREFUSED');
    };
    const result = await submitAndCheck({ url: 'https://example.test', token: 't' }, { markdown: '# plan', planId: 'cc-abc' });
    assert.equal(result.network, true);
    assert.equal(result.stage, 'compile');
  });

  test('unwaived violations from check produce a blocked verdict', async () => {
    let call = 0;
    globalThis.fetch = async () => {
      call += 1;
      if (call === 1) return jsonResponse(200, { planId: 'cc-abc', planHash: 'hash1' });
      if (call === 2) return jsonResponse(200, { report: { flags: [{ id: 'f1', severity: 'violation', code: 'V1', message: 'nope' }] }, binderStats: { total: 1, bound: 1 } });
      return jsonResponse(200, { waivers: [] });
    };
    const result = await submitAndCheck({ url: 'https://example.test', token: 't' }, { markdown: '# plan', planId: 'cc-abc' });
    assert.equal(result.verdict.blocked, true);
  });

  test('a waived violation does not block', async () => {
    let call = 0;
    globalThis.fetch = async () => {
      call += 1;
      if (call === 1) return jsonResponse(200, { planId: 'cc-abc', planHash: 'hash1' });
      if (call === 2) return jsonResponse(200, { report: { flags: [{ id: 'f1', severity: 'violation', code: 'V1', message: 'nope' }] }, binderStats: { total: 1, bound: 1 } });
      return jsonResponse(200, { waivers: [{ flagId: 'f1' }] });
    };
    const result = await submitAndCheck({ url: 'https://example.test', token: 't' }, { markdown: '# plan', planId: 'cc-abc' });
    assert.equal(result.verdict.blocked, false);
  });

  // V11 plugin P1 regression: a non-200 waivers response used to silently fall
  // through to `waivers.json?.waivers ?? []`, computing a verdict as if nothing
  // were waived -- turning a genuinely fully-waived plan into a false BLOCKED
  // report. This must now short-circuit exactly like a non-200 compile/check
  // response does.
  test('a non-200 waivers response does not silently read as "nothing waived" -- it short-circuits with ok:undefined', async () => {
    let call = 0;
    globalThis.fetch = async () => {
      call += 1;
      if (call === 1) return jsonResponse(200, { planId: 'cc-abc', planHash: 'hash1' });
      if (call === 2) return jsonResponse(200, { report: { flags: [{ id: 'f1', severity: 'violation', code: 'V1', message: 'nope' }] }, binderStats: { total: 1, bound: 1 } });
      return jsonResponse(500, { error: 'INTERNAL_ERROR' });
    };
    const result = await submitAndCheck({ url: 'https://example.test', token: 't' }, { markdown: '# plan', planId: 'cc-abc' });
    assert.equal(result.ok, undefined);
    assert.equal(result.stage, 'waivers');
    assert.equal(result.status, 500);
    assert.equal(result.verdict, undefined, 'must never compute a verdict off an unknown waiver set');
  });
});

describe('marker file round trip', () => {
  let dataDir;
  let originalDataEnv;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'architect-plugin-test-'));
    originalDataEnv = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = dataDir;
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    if (originalDataEnv === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = originalDataEnv;
  });

  test('a marker written with a session id is readable by session id', () => {
    const keys = candidateMarkerKeys({ sessionId: 'sess-1', cwd: '/repo' });
    writeMarker(keys, { sessionId: 'sess-1', cwd: '/repo', planId: 'cc-sess1', verdict: { blocked: false }, checkedAt: new Date().toISOString() });
    const found = readFreshMarker(candidateMarkerKeys({ sessionId: 'sess-1', cwd: '/repo' }), { sessionId: 'sess-1', cwd: '/repo' });
    assert.ok(found);
    assert.equal(found.planId, 'cc-sess1');
  });

  test('a marker written with only a cwd is still readable via the cwd-only key when no session id is available at read time', () => {
    const keys = candidateMarkerKeys({ sessionId: undefined, cwd: '/repo' });
    writeMarker(keys, { cwd: '/repo', planId: 'cc-repo', verdict: { blocked: false }, checkedAt: new Date().toISOString() });
    const found = readFreshMarker(candidateMarkerKeys({ sessionId: 'sess-unrelated', cwd: '/repo' }), { sessionId: 'sess-unrelated', cwd: '/repo' });
    assert.ok(found, 'cwd match should still find it even though the reader has a different/unknown session id');
  });

  test('a stale marker (beyond maxAgeMs) is not returned', () => {
    const keys = candidateMarkerKeys({ sessionId: 'sess-1', cwd: '/repo' });
    writeMarker(keys, { sessionId: 'sess-1', cwd: '/repo', planId: 'cc-sess1', verdict: { blocked: false }, checkedAt: new Date(Date.now() - 60_000).toISOString() });
    const found = readFreshMarker(keys, { sessionId: 'sess-1', cwd: '/repo' }, 1000);
    assert.equal(found, undefined);
  });

  test('a marker whose cwd AND session id both differ from the reader is not returned even if the key path collides', () => {
    const keys = candidateMarkerKeys({ sessionId: 'sess-1', cwd: '/repo-a' });
    writeMarker(keys, { sessionId: 'sess-1', cwd: '/repo-a', planId: 'cc-sess1', verdict: { blocked: false }, checkedAt: new Date().toISOString() });
    const found = readFreshMarker(candidateMarkerKeys({ sessionId: 'sess-1', cwd: '/repo-a' }), { sessionId: 'sess-2', cwd: '/repo-b' });
    assert.equal(found, undefined);
  });

  test('no marker at all returns undefined, not a throw', () => {
    const found = readFreshMarker(candidateMarkerKeys({ sessionId: 'nope', cwd: '/nowhere' }), { sessionId: 'nope', cwd: '/nowhere' });
    assert.equal(found, undefined);
  });

  // V11 plugin P1 regression: Date.parse(undefined) / Date.parse('garbage') is
  // NaN, and `Date.now() - NaN` is NaN -- `NaN > maxAgeMs` is false, so the old
  // code fell through and treated a marker with a missing/corrupt checkedAt as
  // fresh. It must now be rejected explicitly.
  test('a marker with a missing checkedAt is rejected, not treated as fresh', () => {
    const keys = candidateMarkerKeys({ sessionId: 'sess-1', cwd: '/repo' });
    writeMarker(keys, { sessionId: 'sess-1', cwd: '/repo', planId: 'cc-sess1', verdict: { blocked: false } });
    const found = readFreshMarker(keys, { sessionId: 'sess-1', cwd: '/repo' });
    assert.equal(found, undefined);
  });

  test('a marker with a malformed (unparseable) checkedAt is rejected, not treated as fresh', () => {
    const keys = candidateMarkerKeys({ sessionId: 'sess-1', cwd: '/repo' });
    writeMarker(keys, { sessionId: 'sess-1', cwd: '/repo', planId: 'cc-sess1', verdict: { blocked: false }, checkedAt: 'not-a-real-date' });
    const found = readFreshMarker(keys, { sessionId: 'sess-1', cwd: '/repo' });
    assert.equal(found, undefined);
  });
});

describe('decideAllow (V11 plugin P2 -- the single allow/deny decision point)', () => {
  test('clean and server-unconfigured always allow, in every mode', () => {
    for (const mode of ['off', 'warn', 'enforce', 'enforce-approvals']) {
      assert.equal(decideAllow(mode, 'clean'), true);
      assert.equal(decideAllow(mode, 'server-unconfigured'), true);
    }
  });

  test('blocked/network/bad-plan/other-error deny only under enforce or enforce-approvals', () => {
    for (const kind of ['blocked', 'network', 'bad-plan', 'other-error']) {
      assert.equal(decideAllow('off', kind), true);
      assert.equal(decideAllow('warn', kind), true);
      assert.equal(decideAllow('enforce', kind), false);
      assert.equal(decideAllow('enforce-approvals', kind), false);
    }
  });

  test('approved and gate-status-unavailable always allow, regardless of mode', () => {
    for (const mode of ['warn', 'enforce', 'enforce-approvals']) {
      assert.equal(decideAllow(mode, 'approved'), true);
      assert.equal(decideAllow(mode, 'gate-status-unavailable'), true);
    }
  });

  test('awaiting-approval denies ONLY under enforce-approvals -- plain enforce allows it', () => {
    assert.equal(decideAllow('enforce-approvals', 'awaiting-approval'), false);
    assert.equal(decideAllow('enforce', 'awaiting-approval'), true);
    assert.equal(decideAllow('warn', 'awaiting-approval'), true);
    assert.equal(decideAllow('off', 'awaiting-approval'), true);
  });
});

describe('evaluateApprovalGate (V11 plugin P3, pure)', () => {
  test('a network failure to reach gate-status is reported as network, not a false deny', () => {
    const outcome = evaluateApprovalGate({ network: true, error: 'timeout' });
    assert.equal(outcome.kind, 'network');
    assert.equal(outcome.detail, 'timeout');
  });

  test('a 404 (pre-V11 server, or a genuinely missing plan) reads as gate-status-unavailable, not a deny', () => {
    const outcome = evaluateApprovalGate({ status: 404 });
    assert.equal(outcome.kind, 'gate-status-unavailable');
  });

  test('a non-200 or shape-less response also reads as gate-status-unavailable', () => {
    assert.equal(evaluateApprovalGate({ status: 500, json: { error: 'INTERNAL_ERROR' } }).kind, 'gate-status-unavailable');
    assert.equal(evaluateApprovalGate({ status: 200, json: {} }).kind, 'gate-status-unavailable');
  });

  test('a satisfied review gate reads as approved', () => {
    const snapshot = { reviewGate: { satisfied: true, have: 1, mode: 'count' } };
    const outcome = evaluateApprovalGate({ status: 200, json: snapshot });
    assert.equal(outcome.kind, 'approved');
    assert.equal(outcome.snapshot, snapshot);
  });

  test('an unsatisfied review gate reads as awaiting-approval, carrying the request outcome through', () => {
    const snapshot = { reviewGate: { satisfied: false, have: 0, openAtCurrentHash: 1, mode: 'count' } };
    const requested = evaluateApprovalGate({ status: 200, json: snapshot }, { requested: true });
    assert.equal(requested.kind, 'awaiting-approval');
    assert.equal(requested.requested, true);

    const noStakeholders = evaluateApprovalGate({ status: 200, json: snapshot }, { noStakeholders: true });
    assert.equal(noStakeholders.kind, 'awaiting-approval');
    assert.equal(noStakeholders.noStakeholders, true);
  });
});

describe('checkApprovalGate (V11 plugin P3, mocked fetch)', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function jsonResponse(status, body) {
    return { status, text: async () => JSON.stringify(body) };
  }

  test('a satisfied gate never calls reviews/request', async () => {
    let calls = 0;
    globalThis.fetch = async (url) => {
      calls += 1;
      assert.match(String(url), /gate-status/);
      return jsonResponse(200, { reviewGate: { satisfied: true, have: 1, mode: 'count' } });
    };
    const outcome = await checkApprovalGate({ url: 'https://example.test', token: 't' }, 'cc-abc');
    assert.equal(outcome.kind, 'approved');
    assert.equal(calls, 1);
  });

  test('an unsatisfied gate with nothing pending auto-requests reviews, then reports awaiting-approval', async () => {
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      if (String(url).includes('gate-status')) {
        return jsonResponse(200, { reviewGate: { satisfied: false, have: 0, openAtCurrentHash: 0, mode: 'count' } });
      }
      return jsonResponse(200, { created: [{ requestedFrom: 'alice' }] });
    };
    const outcome = await checkApprovalGate({ url: 'https://example.test', token: 't' }, 'cc-abc');
    assert.equal(outcome.kind, 'awaiting-approval');
    assert.equal(outcome.requested, true);
    assert.equal(urls.length, 2);
    assert.match(urls[1], /reviews\/request/);
  });

  test('an unsatisfied gate with an already-open request does NOT re-request', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return jsonResponse(200, { reviewGate: { satisfied: false, have: 0, openAtCurrentHash: 1, mode: 'count' } });
    };
    const outcome = await checkApprovalGate({ url: 'https://example.test', token: 't' }, 'cc-abc');
    assert.equal(outcome.kind, 'awaiting-approval');
    assert.equal(outcome.requested, false);
    assert.equal(calls, 1, 'must not POST reviews/request when something is already pending at this hash');
  });

  test('a 409 REVIEW_ALREADY_REQUESTED from the auto-request is treated as idempotent success, not an error', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes('gate-status')) return jsonResponse(200, { reviewGate: { satisfied: false, have: 0, openAtCurrentHash: 0, mode: 'count' } });
      return jsonResponse(409, { error: 'REVIEW_ALREADY_REQUESTED', logins: ['alice'] });
    };
    const outcome = await checkApprovalGate({ url: 'https://example.test', token: 't' }, 'cc-abc');
    assert.equal(outcome.kind, 'awaiting-approval');
    assert.equal(outcome.requested, false);
    assert.equal(outcome.noStakeholders, undefined);
  });

  test('a 409 NO_STAKEHOLDERS_DERIVED surfaces distinctly, so the caller can tell the user to name reviewers', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).includes('gate-status')) return jsonResponse(200, { reviewGate: { satisfied: false, have: 0, openAtCurrentHash: 0, mode: 'count' } });
      return jsonResponse(409, { error: 'NO_STAKEHOLDERS_DERIVED' });
    };
    const outcome = await checkApprovalGate({ url: 'https://example.test', token: 't' }, 'cc-abc');
    assert.equal(outcome.kind, 'awaiting-approval');
    assert.equal(outcome.noStakeholders, true);
  });

  test('a network failure on the gate-status fetch is reported as network, never silently allowed or denied', async () => {
    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const outcome = await checkApprovalGate({ url: 'https://example.test', token: 't' }, 'cc-abc');
    assert.equal(outcome.kind, 'network');
  });
});

describe('probeSessionId', () => {
  test('returns undefined when no candidate env var is set', () => {
    assert.equal(probeSessionId({}), undefined);
  });
  test('prefers CLAUDE_SESSION_ID when both are set', () => {
    assert.equal(probeSessionId({ CLAUDE_SESSION_ID: 'a', CLAUDE_CODE_SESSION_ID: 'b' }), 'a');
  });
});

describe('sha256Hex', () => {
  test('is deterministic', () => {
    assert.equal(sha256Hex('hello'), sha256Hex('hello'));
  });
  test('differs for different input', () => {
    assert.notEqual(sha256Hex('hello'), sha256Hex('world'));
  });
});
