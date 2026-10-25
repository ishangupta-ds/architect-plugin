#!/usr/bin/env node
// SessionStart + PreToolUse(ExitPlanMode) hook: shares WHICH FILES this checkout has changed (names only, never contents) with the teammates reviewing plans that touch
// them. Off unless the developer sets ARCHITECT_LOCAL_STATE=on; the server also needs their consent (a double opt-in). Fire-and-forget: this process returns at once, a
// detached worker does the work, nothing is ever printed (SessionStart stdout would land in Claude's context; PreToolUse stdout is reserved for the gate's JSON), and
// every failure is silent -- sharing local state must never get in the way of a session or a plan.
//
// Credentials: only an ARCHITECT_LOCAL_STATE_TOKEN of the scoped `architect_ls_` kind is used (one workspace, expiring, can do nothing but publish). The full
// ARCHITECT_TOKEN that the gate and the MCP server use is NEVER passed to this worker.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readStdinJson } from './architect-lib.mjs';
import { collectLocalState, runPublish } from './local-state-core.mjs';

export const THROTTLE_MS = 30_000;
export const WORKER_TIMEOUT_MS = 20_000;
const SCOPED_PREFIX = 'architect_ls_';

/** Whether sharing is switched on and configured, from the environment alone. Anything missing means "do nothing, silently". */
export function localStateSettings(env = process.env) {
  const url = (env.ARCHITECT_URL || '').trim();
  const token = (env.ARCHITECT_LOCAL_STATE_TOKEN || '').trim();
  if (env.ARCHITECT_LOCAL_STATE !== 'on') return { enabled: false, why: 'ARCHITECT_LOCAL_STATE is not "on"' };
  if (!url) return { enabled: false, why: 'ARCHITECT_URL is not set' };
  if (!token.startsWith(SCOPED_PREFIX)) return { enabled: false, why: 'ARCHITECT_LOCAL_STATE_TOKEN is not set to an architect_ls_ token' };
  return { enabled: true, url, token, workspace: env.ARCHITECT_WORKSPACE || '', exclude: env.ARCHITECT_LOCAL_STATE_EXCLUDE || '' };
}

/** The ONLY environment the worker gets: nothing else of the user's (in particular not ARCHITECT_TOKEN) is passed along. */
export function workerEnv(settings) {
  return {
    ARCHITECT_LOCAL_STATE: 'on',
    ARCHITECT_URL: settings.url,
    ARCHITECT_LOCAL_STATE_TOKEN: settings.token,
    ...(settings.workspace ? { ARCHITECT_WORKSPACE: settings.workspace } : {}),
    ...(settings.exclude ? { ARCHITECT_LOCAL_STATE_EXCLUDE: settings.exclude } : {}),
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || homedir(),
    // Where the plugin keeps its state, so the worker records its outcome beside the throttle stamp the hook wrote (not a secret).
    ...(process.env.CLAUDE_PLUGIN_DATA ? { CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA } : {}),
  };
}

export function stateDir(env = process.env) {
  return join(env.CLAUDE_PLUGIN_DATA || join(env.HOME || homedir(), '.architect-plugin-data'), 'local-state');
}

const keyFor = (cwd) => createHash('sha256').update(cwd).digest('hex').slice(0, 16);

/** True when this checkout was published within THROTTLE_MS (SessionStart and the ExitPlanMode hook often fire seconds apart). Records "now" otherwise. */
export function throttled(cwd, now = Date.now(), env = process.env) {
  const dir = stateDir(env);
  const file = join(dir, `${keyFor(cwd)}.stamp`);
  try {
    if (now - statSync(file).mtimeMs < THROTTLE_MS) return true;
  } catch {
    // no stamp yet
  }
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, String(now), 'utf8');
  } catch {
    // an unwritable state dir just means no throttling
  }
  return false;
}

const redact = (text) => text.replace(/architect_ls_[0-9a-f]{8,}/gi, '***').replace(/\b(?:architect|scim)_[0-9a-f]{32,}\b/gi, '***');

/** The detached worker: collect, publish, record the outcome (a code and one redacted line, never the payload or token) for `cat`-ing when something seems off. */
export async function runWorker(cwd, settings, env = process.env) {
  const lines = [];
  const code = await runPublish(['--repo', cwd], workerEnv(settings), {
    fetchImpl: fetch,
    collect: collectLocalState,
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
  }).catch(() => 1);
  try {
    const dir = stateDir(env);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${keyFor(cwd)}.last.json`), JSON.stringify({ at: new Date().toISOString(), exitCode: code, message: redact(lines[0] || '').slice(0, 300) }), 'utf8');
  } catch {
    // best effort
  }
  return code;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--worker') {
    const settings = localStateSettings(process.env);
    const cwd = argv[1];
    const timer = setTimeout(() => process.exit(0), WORKER_TIMEOUT_MS);
    timer.unref();
    if (settings.enabled && cwd) await runWorker(cwd, settings);
    process.exit(0);
  }
  const input = await readStdinJson();
  const settings = localStateSettings(process.env);
  if (!settings.enabled) return;
  const cwd = (typeof input.cwd === 'string' && input.cwd) || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (throttled(cwd)) return;
  spawnWorker(cwd, settings);
}

/** Starts the detached worker that does the network part, with the minimal environment. The caller does not wait for it. */
export function spawnWorker(cwd, settings, spawnImpl = spawn) {
  spawnImpl(process.execPath, [fileURLToPath(import.meta.url), '--worker', cwd], { detached: true, stdio: 'ignore', env: workerEnv(settings) }).unref();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    () => process.exit(0),
    () => process.exit(0), // never fail a session over this
  );
}
