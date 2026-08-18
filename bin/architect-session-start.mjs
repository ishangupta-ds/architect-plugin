#!/usr/bin/env node
// SessionStart hook (startup|resume|clear) -- plain stdout here IS injected into
// Claude's context (unlike PreToolUse, where stdout is reserved for the JSON
// control line), so this stays short: gate status survives /clear + compaction.
import { deriveSessionPlanId, readStdinJson, resolveConfig } from './architect-lib.mjs';

async function main() {
  const input = await readStdinJson();
  const config = resolveConfig();
  const planId = deriveSessionPlanId(input.session_id);

  const lines = [];
  if (config.mode === 'off') {
    lines.push('Architect gate: disabled (ARCHITECT_GATE=off).');
  } else if (!config.configured) {
    lines.push('Architect gate: not configured (ARCHITECT_URL/ARCHITECT_TOKEN unset) -- plan mode is UNGATED. See the architect-workflow skill to set up.');
  } else {
    lines.push(`Architect gate: ${config.mode} at ${config.url}. This session's plan will be tracked as planId ${planId} -- ExitPlanMode is checked against Architect's recorded decisions before it's allowed.`);
    lines.push('Run /architect:architect-workflow for the full submit -> check -> resolve/waive -> re-check loop.');
  }

  process.stdout.write(lines.join('\n'));
}

main();
