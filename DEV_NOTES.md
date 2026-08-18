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
