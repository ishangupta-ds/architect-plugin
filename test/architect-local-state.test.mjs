import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { THROTTLE_MS, localStateSettings, spawnWorker, stateDir, throttled, workerEnv } from '../bin/architect-local-state.mjs';
import * as core from '../bin/local-state-core.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const HOOK = join(root, 'bin', 'architect-local-state.mjs');
const TOKEN = `architect_ls_${'ab'.repeat(32)}`;
const FULL_TOKEN = `architect_${'cd'.repeat(32)}`;
const fixture = JSON.parse(readFileSync(join(root, 'test', 'fixtures', 'local-state-contract.json'), 'utf8'));

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
const put = (dir, rel, content = rel) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
};

/** A clone with local work on a feature branch; its origin looks like a GitHub remote. */
function checkout() {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-ls-'));
  const seed = join(dir, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  put(seed, 'README.md');
  put(seed, 'src/a.ts');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'one');
  git(dir, 'clone', '-q', '--bare', seed, join(dir, 'remote.git'));
  const co = join(dir, 'checkout');
  git(dir, 'clone', '-q', `file://${join(dir, 'remote.git')}`, co);
  git(co, 'remote', 'set-url', 'origin', 'https://github.com/acme/widgets.git');
  git(co, 'checkout', '-q', '-b', 'feat/x');
  put(co, 'src/a.ts', 'changed');
  put(co, '.env', 'SECRET=1');
  git(co, 'add', '-A');
  git(co, 'commit', '-q', '-m', 'work');
  put(co, 'README.md', 'uncommitted');
  return co;
}

/** A stand-in Architect that records requests and answers with a canned status. */
function fakeServer(status = 200, body = { ok: true, expiresAt: '2030-01-01T00:00:00.000Z' }) {
  const requests = [];
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: data });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ requests, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

/** Runs the hook like Claude Code does (JSON on stdin) and waits for it AND its detached worker. */
async function runHook(env, input = {}, { waitFor } = {}) {
  const child = spawn(process.execPath, [HOOK], { env: { PATH: process.env.PATH, HOME: env.HOME, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  child.stdin.end(JSON.stringify(input));
  const started = Date.now();
  const code = await new Promise((r) => child.on('close', r));
  const elapsed = Date.now() - started;
  if (waitFor) for (let i = 0; i < 100 && !(await waitFor()); i++) await new Promise((r) => setTimeout(r, 50));
  return { code, stdout, stderr, elapsed };
}

const baseEnv = (server, home, extra = {}) => ({ HOME: home, CLAUDE_PLUGIN_DATA: join(home, 'data'), ARCHITECT_LOCAL_STATE: 'on', ARCHITECT_URL: server.url, ARCHITECT_LOCAL_STATE_TOKEN: TOKEN, ARCHITECT_WORKSPACE: 'ws-1', ...extra });

describe('localStateSettings', () => {
  const ok = { ARCHITECT_LOCAL_STATE: 'on', ARCHITECT_URL: 'https://a.example.com', ARCHITECT_LOCAL_STATE_TOKEN: TOKEN };
  test('enabled only when switched on, with a URL and a SCOPED token', () => {
    assert.equal(localStateSettings(ok).enabled, true);
    assert.equal(localStateSettings({}).enabled, false);
    for (const v of ['true', '1', 'ON', 'yes', '']) assert.equal(localStateSettings({ ...ok, ARCHITECT_LOCAL_STATE: v }).enabled, false, v);
    assert.equal(localStateSettings({ ...ok, ARCHITECT_URL: '' }).enabled, false);
    assert.equal(localStateSettings({ ...ok, ARCHITECT_LOCAL_STATE_TOKEN: '' }).enabled, false);
  });
  test('a FULL token is never used: not as the local-state token, and not as a fallback when only ARCHITECT_TOKEN is set', () => {
    assert.equal(localStateSettings({ ...ok, ARCHITECT_LOCAL_STATE_TOKEN: FULL_TOKEN }).enabled, false);
    assert.equal(localStateSettings({ ARCHITECT_LOCAL_STATE: 'on', ARCHITECT_URL: 'https://a.example.com', ARCHITECT_TOKEN: FULL_TOKEN }).enabled, false);
  });
  test('the worker environment carries the scoped token and NOTHING else of the user\'s (no ARCHITECT_TOKEN, no other variables)', () => {
    process.env.CLAUDE_PLUGIN_DATA = '/some/plugin/data';
    const env = workerEnv(localStateSettings({ ...ok, ARCHITECT_TOKEN: FULL_TOKEN, AWS_SECRET_ACCESS_KEY: 'x', ARCHITECT_WORKSPACE: 'ws-9', ARCHITECT_LOCAL_STATE_EXCLUDE: 'docs/**' }));
    delete process.env.CLAUDE_PLUGIN_DATA;
    assert.equal(env.CLAUDE_PLUGIN_DATA, '/some/plugin/data');
    assert.equal(env.ARCHITECT_LOCAL_STATE_TOKEN, TOKEN);
    assert.equal(env.ARCHITECT_WORKSPACE, 'ws-9');
    assert.equal(env.ARCHITECT_LOCAL_STATE_EXCLUDE, 'docs/**');
    assert.deepEqual(Object.keys(env).sort(), ['ARCHITECT_LOCAL_STATE', 'ARCHITECT_LOCAL_STATE_EXCLUDE', 'ARCHITECT_LOCAL_STATE_TOKEN', 'ARCHITECT_URL', 'ARCHITECT_WORKSPACE', 'CLAUDE_PLUGIN_DATA', 'HOME', 'PATH']);
    assert.ok(!JSON.stringify(env).includes(FULL_TOKEN));
  });
});

describe('spawnWorker', () => {
  test('starts a DETACHED, output-less worker with only the minimal environment, and does not wait for it', () => {
    const calls = [];
    let unref = false;
    const fakeSpawn = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { unref: () => (unref = true) };
    };
    process.env.ARCHITECT_TOKEN = FULL_TOKEN;
    try {
      spawnWorker('/some/repo', localStateSettings({ ARCHITECT_LOCAL_STATE: 'on', ARCHITECT_URL: 'https://a.example.com', ARCHITECT_LOCAL_STATE_TOKEN: TOKEN }), fakeSpawn);
    } finally {
      delete process.env.ARCHITECT_TOKEN;
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, process.execPath);
    assert.deepEqual(calls[0].args.slice(1), ['--worker', '/some/repo']);
    assert.equal(calls[0].opts.detached, true);
    assert.equal(calls[0].opts.stdio, 'ignore');
    assert.equal(unref, true);
    assert.ok(!('ARCHITECT_TOKEN' in calls[0].opts.env), 'the full token must not reach the worker process');
    assert.equal(calls[0].opts.env.ARCHITECT_LOCAL_STATE_TOKEN, TOKEN);
  });
});

describe('throttled', () => {
  test('the first call goes through, repeats within the window are held back, and a later one goes through again', () => {
    const data = mkdtempSync(join(tmpdir(), 'plugin-throttle-'));
    const env = { CLAUDE_PLUGIN_DATA: data };
    const t0 = Date.now() + 10_000_000; // far enough ahead that a stamp written "now" is always older
    assert.equal(throttled('/repo/a', t0, env), false);
    assert.equal(throttled('/repo/a', t0 + 1000, env), false, 'the stamp mtime is real time, so a synthetic later call is past the window');
    assert.equal(throttled('/repo/a', Date.now(), env), true);
    assert.equal(throttled('/repo/b', Date.now(), env), false, 'per checkout');
    assert.ok(THROTTLE_MS >= 10_000);
  });
  test('an unwritable state directory means no throttling, not an error', () => {
    assert.equal(throttled('/repo/c', Date.now(), { CLAUDE_PLUGIN_DATA: '/proc/definitely/not/writable' }), false);
  });
});

describe('the hook process', () => {
  let server;
  before(async () => {
    server = await fakeServer();
  });
  after(async () => {
    await server.close();
  });

  test('does nothing and prints nothing when not switched on (no request, no state written)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'plugin-home-'));
    const before = server.requests.length;
    const r = await runHook(baseEnv(server, home, { ARCHITECT_LOCAL_STATE: '' }), { cwd: checkout() });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(server.requests.length, before);
    assert.equal(existsSync(join(home, 'data')), false);
  });

  test('returns at once, silently, and a detached worker PUTs only file names -- never contents, never the credentials file -- with the scoped token', async () => {
    const home = mkdtempSync(join(tmpdir(), 'plugin-home-'));
    const co = checkout();
    const before = server.requests.length;
    const r = await runHook(baseEnv(server, home), { cwd: co, hook_event_name: 'SessionStart' }, { waitFor: () => server.requests.length > before });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', 'SessionStart stdout would be injected into Claude\'s context');
    assert.equal(r.stderr, '');
    assert.ok(r.elapsed < 2000, `the hook itself must not wait for the network (took ${r.elapsed} ms)`);
    assert.equal(server.requests.length, before + 1);
    const req = server.requests.at(-1);
    assert.equal(req.method, 'PUT');
    assert.equal(req.url, '/api/w/ws-1/local-state');
    assert.equal(req.auth, `Bearer ${TOKEN}`);
    const payload = JSON.parse(req.body);
    assert.deepEqual(payload.paths, ['README.md', 'src/a.ts']);
    assert.equal(payload.branch, 'feat/x');
    assert.deepEqual(payload.repo, { provider: 'github', ownerRepo: 'acme/widgets' });
    assert.equal(payload.workingTreeDirty, true);
    assert.ok(!req.body.includes('.env'));
    assert.ok(!req.body.includes('SECRET'));
    assert.ok(!req.body.includes('uncommitted'), 'file CONTENTS are never sent');
  });

  test('the payload only uses fields the shared contract knows about, and has the required ones', async () => {
    const known = new Set(fixture.valid.flatMap((c) => Object.keys(c.payload)));
    const home = mkdtempSync(join(tmpdir(), 'plugin-home-'));
    const before = server.requests.length;
    await runHook(baseEnv(server, home), { cwd: checkout() }, { waitFor: () => server.requests.length > before });
    const payload = JSON.parse(server.requests.at(-1).body);
    for (const key of Object.keys(payload)) assert.ok(known.has(key), `unknown field ${key} is not in the contract fixture`);
    for (const key of ['repo', 'branch', 'headSha', 'workingTreeDirty', 'paths']) assert.ok(key in payload, `missing required ${key}`);
    assert.match(payload.headSha, /^[0-9a-f]{40}$/);
  });

  test('a second hook for the same checkout within the throttle window does not publish again', async () => {
    const home = mkdtempSync(join(tmpdir(), 'plugin-home-'));
    const co = checkout();
    const env = baseEnv(server, home);
    const before = server.requests.length;
    await runHook(env, { cwd: co }, { waitFor: () => server.requests.length > before });
    assert.equal(server.requests.length, before + 1);
    await runHook(env, { cwd: co });
    await new Promise((res) => setTimeout(res, 500));
    assert.equal(server.requests.length, before + 1);
  });

  test('records the outcome for debugging -- a code and one line, never the token or the payload', async () => {
    const home = mkdtempSync(join(tmpdir(), 'plugin-home-'));
    const co = checkout();
    const env = baseEnv(server, home);
    const dir = join(home, 'data', 'local-state');
    await runHook(env, { cwd: co }, { waitFor: () => existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.last.json')) });
    const file = readdirSync(dir).find((f) => f.endsWith('.last.json'));
    const last = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    assert.equal(last.exitCode, 0);
    assert.match(last.message, /shared 2 file\(s\) of acme\/widgets@feat\/x/);
    const raw = readFileSync(join(dir, file), 'utf8');
    assert.ok(!raw.includes(TOKEN));
    assert.ok(!raw.includes('src/a.ts'));
  });

  test('falls back to CLAUDE_PROJECT_DIR when the hook input has no cwd', async () => {
    const home = mkdtempSync(join(tmpdir(), 'plugin-home-'));
    const co = checkout();
    const before = server.requests.length;
    await runHook(baseEnv(server, home, { CLAUDE_PROJECT_DIR: co }), {}, { waitFor: () => server.requests.length > before });
    assert.equal(server.requests.length, before + 1);
    assert.equal(JSON.parse(server.requests.at(-1).body).repo.ownerRepo, 'acme/widgets', 'the project directory\'s repository, not whatever directory the hook happened to run in');
  });

  test('a directory that is not a repository, or a repo with no GitHub origin, shares nothing and still exits 0 quietly', async () => {
    const home = mkdtempSync(join(tmpdir(), 'plugin-home-'));
    const before = server.requests.length;
    for (const cwd of [mkdtempSync(join(tmpdir(), 'plugin-plain-')), (() => { const c = checkout(); git(c, 'remote', 'set-url', 'origin', 'https://git.example.com/a/b.git'); return c; })()]) {
      const r = await runHook(baseEnv(server, mkdtempSync(join(tmpdir(), 'plugin-home-')), {}), { cwd });
      assert.equal(r.code, 0);
      assert.equal(r.stdout + r.stderr, '');
    }
    await new Promise((res) => setTimeout(res, 400));
    assert.equal(server.requests.length, before);
    void home;
  });
});

describe('the hook never gets in the way of a session', () => {
  for (const [name, status, body] of [['consent required (409)', 409, { error: 'CONSENT_REQUIRED', hint: 'opt in first' }], ['not registered (404)', 404, { error: 'REPO_NOT_REGISTERED' }], ['forbidden (403)', 403, { error: 'TOKEN_SCOPE_FORBIDDEN' }], ['rate limited (429)', 429, { error: 'RATE_LIMITED' }], ['server error (500)', 500, { error: 'boom' }]]) {
    test(`silent exit 0 on ${name}; the reason is recorded`, async () => {
      const server = await fakeServer(status, body);
      try {
        const home = mkdtempSync(join(tmpdir(), 'plugin-home-'));
        const dir = join(home, 'data', 'local-state');
        const r = await runHook(baseEnv(server, home), { cwd: checkout() }, { waitFor: () => existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.last.json')) });
        assert.equal(r.code, 0);
        assert.equal(r.stdout + r.stderr, '');
        const last = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith('.last.json'))), 'utf8'));
        assert.notEqual(last.exitCode, 0);
        assert.ok(!last.message.includes(TOKEN));
      } finally {
        await server.close();
      }
    });
  }

  test('an unreachable server is silent too', async () => {
    const server = await fakeServer();
    const url = server.url;
    await server.close();
    const home = mkdtempSync(join(tmpdir(), 'plugin-home-'));
    const dir = join(home, 'data', 'local-state');
    const r = await runHook({ ...baseEnv({ url }, home) }, { cwd: checkout() }, { waitFor: () => existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.last.json')) });
    assert.equal(r.code, 0);
    assert.equal(r.stdout + r.stderr, '');
  });

  test('garbage on stdin does not matter', async () => {
    const server = await fakeServer();
    try {
      const child = spawn(process.execPath, [HOOK], { env: { PATH: process.env.PATH, ...baseEnv(server, mkdtempSync(join(tmpdir(), 'plugin-home-')), { ARCHITECT_LOCAL_STATE: '' }) } });
      child.stdin.end('{not json');
      assert.equal(await new Promise((r) => child.on('close', r)), 0);
    } finally {
      await server.close();
    }
  });
});

describe('hooks.json wiring', () => {
  const hooks = JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const commands = (event, matcher) => hooks[event].filter((g) => !matcher || g.matcher === matcher).flatMap((g) => g.hooks.map((h) => h.command));
  test('runs on SessionStart and before ExitPlanMode, next to (not instead of) the existing hooks, with a short timeout', () => {
    assert.ok(commands('SessionStart').some((c) => c.includes('architect-local-state.mjs')));
    assert.ok(commands('SessionStart').some((c) => c.includes('architect-session-start.mjs')));
    assert.ok(commands('PreToolUse', 'ExitPlanMode').some((c) => c.includes('architect-local-state.mjs')));
    assert.ok(commands('PreToolUse', 'ExitPlanMode').some((c) => c.includes('architect-gate.mjs')));
    assert.ok(!commands('PostToolUse').some((c) => c.includes('architect-local-state.mjs')));
    for (const group of [...hooks.SessionStart, ...hooks.PreToolUse]) for (const h of group.hooks) if (h.command.includes('architect-local-state')) assert.ok(h.timeout > 0 && h.timeout <= 15);
  });
});

describe('the bundled core and the contract fixture', () => {
  test('the bundle was built against exactly this fixture copy (copy BOTH from the architect repo when either changes)', () => {
    const header = readFileSync(join(root, 'bin', 'local-state-core.mjs'), 'utf8').split('\n').slice(0, 3).join('\n');
    const recorded = header.match(/contract-fixture-sha256: ([0-9a-f]{64})/)?.[1];
    const actual = createHash('sha256').update(readFileSync(join(root, 'test', 'fixtures', 'local-state-contract.json'))).digest('hex');
    assert.equal(recorded, actual);
  });
  test('exposes what the hook uses and imports only node builtins', () => {
    for (const name of ['runPublish', 'collectLocalState', 'parseRemote', 'matchesGlob', 'isSafeServerUrl', 'parsePublishArgs']) assert.equal(typeof core[name], 'function', name);
    const src = readFileSync(join(root, 'bin', 'local-state-core.mjs'), 'utf8');
    for (const m of src.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)) assert.match(m[1], /^node:/);
  });
  test('the fixture is intact (it is a shared contract, not a scratch file)', () => {
    assert.ok(fixture.valid.length >= 3);
    assert.ok(fixture.invalid.length >= 20);
  });
});

describe('validate.mjs', () => {
  test('fails when the bundle and the contract fixture copy do not belong together', () => {
    const copy = mkdtempSync(join(tmpdir(), 'plugin-validate-'));
    for (const rel of ['bin', 'hooks', '.claude-plugin', 'test/fixtures', '.mcp.json']) cpSync(join(root, rel), join(copy, rel), { recursive: true });
    const run = () => {
      try {
        execFileSync(process.execPath, [join(copy, 'bin', 'validate.mjs')], { stdio: 'pipe' });
        return 0;
      } catch (e) {
        return e.status;
      }
    };
    assert.equal(run(), 0);
    writeFileSync(join(copy, 'test', 'fixtures', 'local-state-contract.json'), '{"valid":[],"invalid":[],"changed":true}');
    assert.equal(run(), 1);
  });
});
