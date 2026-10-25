# Dev notes — day-1 verification findings

Recorded per the build plan's own requirement to verify (not assume) three things
before the gate hook design was finalized.

## 1. Marketplace manifest location — CONFIRMED

`.claude-plugin/marketplace.json` at the plugin **repo root** is correct. Verified
locally:

```
claude plugin marketplace add ./     # from inside this repo
# -> Successfully added marketplace: architect-plugin (declared in user settings)
claude plugin install architect@architect-plugin
# -> Successfully installed plugin: architect@architect-plugin (scope: user)
claude plugin details architect
#   Hooks (3)  PreToolUse, PostToolUse, SessionStart
#   MCP servers (1)  architect
```

`plugin.json`'s `name` field ("architect") and `hooks/hooks.json`'s three hook
entries were all picked up correctly with zero errors.

## 2. `${VAR}` interpolation in `.mcp.json` — SIDESTEPPED, not tested

The bash-style `${VAR:-default}` conditional-default form is **not confirmed** to be
supported by Claude Code's plugin config interpolation (the public docs don't state
either way). Rather than risk shipping something that silently mis-interpolates,
`.mcp.json` uses plain, unconditional `${ARCHITECT_URL}` / `${ARCHITECT_TOKEN}` —
both are REQUIRED environment variables the user sets during setup (documented in
the skill and this repo's setup docs). No default-value syntax is relied upon.

## 3. `ExitPlanMode`'s `PreToolUse` `tool_input` payload — NOT YET VERIFIED

**This one genuinely needs a live, interactive Claude Code session** (a human
approving a real plan-mode proposal) — it cannot be observed from an automated
execution context, since plan-mode approval is inherently a human-in-the-loop
action and hooks are harness-side, invisible to the agent unless the harness itself
surfaces them.

**To verify** (run once, by a human, before relying on the "primary" fast path):

1. Temporarily replace `hooks/hooks.json`'s `PreToolUse`/`PostToolUse` commands with
   a dump hook:
   ```json
   "command": "node -e \"process.stdin.pipe(require('fs').createWriteStream(process.env.CLAUDE_PLUGIN_DATA + '/dump-' + Date.now() + '.json'))\""
   ```
2. `claude --plugin-dir /path/to/architect-plugin`
3. Start a plan-mode session, write any plan, approve it (accept `ExitPlanMode`).
4. Inspect the dumped JSON files in `${CLAUDE_PLUGIN_DATA}` (printed by
   `claude plugin details architect` or found under
   `~/.claude/plugins/data/architect/`).
5. Check whether the `PreToolUse` dump's `tool_input` field contains a non-empty
   `plan` string.

**Until this is verified**, `architect-gate.mjs` (see `bin/`) ships **both** code
paths unconditionally: it uses `tool_input.plan` when present and non-empty,
and falls back to the session-scoped marker-file protocol
(`architect-submit.mjs` + `${CLAUDE_PLUGIN_DATA}/gate-state/<session_id>.json`)
otherwise — so correctness does not depend on knowing the answer in advance. This
note should be updated (and the dead code path considered for removal) once a real
session confirms which path is actually exercised in practice.

## 4. `enforce-approvals` mode worst-case latency — computed, NOT yet measured in a real session

`ARCHITECT_GATE=enforce-approvals` (added alongside the server's V11 wedge) adds up
to two more network calls (`GET .../gate-status`, `POST .../reviews/request`, each
a 5s `fetchGateStatus`/`requestReviewsAuto` timeout) on top of the base
`submitAndCheck` path's three calls (`compile`/`check`/`waivers`, each an 8s
`architectRequest` timeout). Worst case, every call individually times out before
failing: `3 × 8s + 2 × 5s = 34s`. The `PreToolUse` hook's own budget is documented
elsewhere in this repo as roughly 60s, so this leaves real margin (~26s) even at the
theoretical worst case — but this is arithmetic on the configured timeouts, not a
measurement against a real, possibly-slow-network Claude Code session. **Still open**:
run a real `enforce-approvals` session against a live server and record the
observed p50/p95 hook latency here, the same way finding #3 above needs a real
session to resolve. If real-world latency ever gets uncomfortably close to the hook
ceiling, the fix is almost certainly parallelizing `fetchGateStatus`'s eventual
poll retries client-side (the plugin itself never long-polls; each `ExitPlanMode`
retry is one fresh, fast round trip), not raising these per-call timeouts.

## 4. Local state: the generated core and the contract fixture

`bin/local-state-core.mjs` is NOT hand-written: it is the architect repo's collector + publisher (`src/server/local-state`) bundled into one dependency-free file by
`pnpm build:plugin-bundle` there (committed as `plugin-dist/local-state-core.mjs`; architect's own tests fail if that copy is stale). `test/fixtures/local-state-contract.json`
is the shared publish contract the server validates against. The bundle's header records the sha256 of the fixture it was built with; `node bin/validate.mjs` and the tests
fail if the two copies here disagree. **To update**: change the source in the architect repo, run `pnpm build:plugin-bundle` there, copy `plugin-dist/local-state-core.mjs`
to `bin/` and `src/shared/fixtures/local-state-contract.json` to `test/fixtures/` here, run `node --test`, bump the version.

The wrapper `bin/architect-local-state.mjs` is hand-written and deliberately minimal: it needs `ARCHITECT_LOCAL_STATE=on`, `ARCHITECT_URL` and an `architect_ls_` token in
`ARCHITECT_LOCAL_STATE_TOKEN` (a full token is refused, and is never passed to the worker); it returns at once and a detached worker (given only that token, the URL,
the workspace, the exclude list, PATH/HOME and the plugin data dir) does the work; a 30 s per-checkout throttle stops SessionStart and the ExitPlanMode hook from publishing twice in a row.
Nothing is printed (SessionStart stdout would enter Claude's context; PreToolUse stdout is the gate's JSON) and every failure exits 0.

