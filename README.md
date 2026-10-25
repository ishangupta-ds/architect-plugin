# architect (Claude Code plugin)

Deterministically gates Claude Code plan mode against
[Architect](https://architect.intutic.ai), an architecture-decision copilot: before a
plan can be proposed, it is submitted, checked against recorded decisions, and any
unwaived violation blocks `ExitPlanMode` until resolved or explicitly waived. An
optional `enforce-approvals` mode goes further, additionally requiring a human
reviewer to approve the plan before `ExitPlanMode` is allowed through (see "Gate
modes" below). See
[ishangupta-ds/architect](https://github.com/ishangupta-ds/architect) for the server
this plugin talks to.

This is a **deterministic** gate, not a prompt-discipline one — the `PreToolUse` hook
calls Architect's real API and denies `ExitPlanMode` when the check comes back
blocked. There's no step for the model to skip.

## Setup

1. **Mint an API token** against your Architect deployment (from the `architect`
   server repo):
   ```bash
   pnpm auth:token -- --login <your-github-login> --label claude-code-plugin
   ```
   This prints an `architect_…` token **once** — save it.

2. **Export the connection env vars** in your shell profile:
   ```bash
   export ARCHITECT_URL=https://architect.intutic.ai
   export ARCHITECT_TOKEN=architect_...
   ```
   Optional: `ARCHITECT_WORKSPACE=<workspace-id>` to target a non-default
   workspace; `ARCHITECT_GATE=enforce|warn|off|enforce-approvals` to override
   the default (see "Gate modes" below).

3. **Install the plugin**, inside a Claude Code session:
   ```
   /plugin marketplace add ishangupta-ds/architect-plugin
   /plugin install architect@architect-plugin
   ```

4. **Verify**: start a new session (or `/clear`) and confirm the `SessionStart`
   banner appears, naming the gate mode and the `planId` this session will use.

5. Read the [`architect-workflow` skill](skills/architect-workflow/SKILL.md) for
   the full submit → check → resolve/waive → re-check loop, or just start plan
   mode — the skill triggers automatically on plan-shaped requests.

## Gate modes (`ARCHITECT_GATE`)

| Mode | When it applies | Behavior |
|---|---|---|
| `off` | explicit opt-out | Never checks, never blocks. |
| `warn` | default when `ARCHITECT_TOKEN` is unset | Checks when possible; never actually blocks `ExitPlanMode` — denials become informational reasons only. |
| `enforce` | default once `ARCHITECT_TOKEN` is set | A real unwaived violation, an unreachable server, or a malformed plan denies `ExitPlanMode`. Server-side misconfiguration (no planner model, no code snapshot imported) still allows through — that's an operator problem, not a plan problem. |
| `enforce-approvals` | always explicit opt-in, never a default | Everything `enforce` does, **plus**: a clean/waived plan additionally checks the server's live review-approval gate (`GET .../gate-status`) before allowing. If it isn't satisfied and nobody has an open review request yet, the gate auto-requests reviewers on your behalf (`POST .../reviews/request {auto:true}`) and denies with instructions to poll `gate-status?wait=25&since=<fingerprint>` until it's satisfied, then retry. Requires a V11+ Architect deployment — against an older server (`gate-status` 404s), it allows through with an upgrade note instead of blocking on a feature the server doesn't have. |

Setting a token is what flips the default from `warn` to `enforce` — configuring
the gate is treated as opting into it being real. `enforce-approvals` is never
reached by default in either case — you must set `ARCHITECT_GATE=enforce-approvals`
explicitly, since it changes the loop (a plan can now sit "awaiting approval" even
with zero violations) in a way plain `enforce` never does.

## Sharing local state with teammates (optional, off by default)

If you and your teammates use Architect's reviewer context, the plugin can tell the server **which files you have changed locally but not pushed**, so a reviewer
reading a plan sees "alice has uncommitted changes to 2 of the files this plan touches". It is a **double opt-in**, shares **file names only** (never contents or diffs),
and a teammate only ever sees the files that overlap the plan they are looking at.

1. **Opt in on the server**, from a signed-in browser session: `PUT /api/local-state/consent {"enabled": true}` for your workspace (the operator must have enabled
   `LOCAL_STATE`). Withdrawing (`{"enabled": false}`) deletes everything you shared.
2. **Mint a scoped token** -- it is bound to one workspace, expires (30 days by default) and can do nothing except publish local state:
   `pnpm auth:token -- --login <you> --label laptop --scope local-state --workspace <id>` (or `POST /api/auth/local-state-tokens` from a session).
3. **Turn it on here**, in your shell profile:
   ```bash
   export ARCHITECT_LOCAL_STATE=on
   export ARCHITECT_LOCAL_STATE_TOKEN=architect_ls_...      # the scoped token; your ARCHITECT_TOKEN is never used for this
   export ARCHITECT_WORKSPACE=<workspace-id>                  # optional; the token already names its workspace
   export ARCHITECT_LOCAL_STATE_EXCLUDE='docs/**,*.md'        # optional extra exclusions (comma-separated globs)
   ```

What happens: at session start and just before `ExitPlanMode`, a detached worker reads your checkout with **read-only git** (no fetch, nothing written, your index
untouched) and sends the branch, `HEAD`, how far you are ahead/behind origin's default branch (as of your last fetch), whether tracked files have uncommitted
changes, and the **names** of files changed relative to the default branch. Files named like credentials (`.env*`, `*.pem`, `id_rsa*`, `secrets/`, ...) are never listed.
The hook returns immediately, prints nothing, and never fails a session: if the server says no (no consent yet, repo not registered, rate limited ...) it is silent.
To see why nothing arrives, look at `${CLAUDE_PLUGIN_DATA:-~/.architect-plugin-data}/local-state/*.last.json` (an exit code and one line; never your token or file names).
To preview exactly what would be sent, run the server repo's `pnpm local-state:publish -- --dry-run`. Shared lists expire after 24 hours.

## Repo layout

- `bin/architect-lib.mjs` — shared HTTP client, verdict computation, marker
  protocol (see `DEV_NOTES.md` for why a marker-file fallback exists at all).
- `bin/architect-gate.mjs` — the `PreToolUse`/`PostToolUse` hook on `ExitPlanMode`.
- `bin/architect-submit.mjs` — standalone CLI (`architect-submit.mjs <plan-file>`)
  for the fallback path, and useful on its own to check a plan file before
  drafting it in-conversation.
- `bin/architect-session-start.mjs` — the `SessionStart` context banner.
- `bin/architect-local-state.mjs` — the optional local-state hook (above); `bin/local-state-core.mjs` is its collector, **generated** from the architect repo (do not edit; see `DEV_NOTES.md`).
- `skills/architect-workflow/SKILL.md` — the workflow guidance Claude reads.
- `.mcp.json` — bundles Architect's remote MCP server (the tool-calling surface
  the skill prefers over the raw REST API).
- `DEV_NOTES.md` — day-1 verification findings and one still-open question about
  Claude Code's own `ExitPlanMode` hook payload (read this if a hook seems to be
  taking the "wrong" code path).

## Development

```bash
node bin/validate.mjs   # manifest + script syntax sanity check
node --test              # unit tests (Node's built-in test runner, zero deps)
```

Local iteration without publishing: `claude --plugin-dir /path/to/this/repo`.

## License

MIT — see `LICENSE`. This repo contains only plugin glue (hooks, a skill, an MCP
client config); the Architect server itself is
[ishangupta-ds/architect](https://github.com/ishangupta-ds/architect) (private).
