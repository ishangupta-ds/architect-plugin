---
name: architect-workflow
description: Use whenever drafting or revising a plan in a repo tracked by Architect (an architecture-decision copilot) -- especially during Claude Code's own plan mode. Explains how the ExitPlanMode gate works, how to read a check report, and how to resolve or waive a flagged violation. Triggers on "plan", "architecture", "plan mode", "propose a plan", "design change".
---

# Working with the Architect gate

This repo has the `architect` plugin installed, which gates `ExitPlanMode` against
[Architect](https://github.com/ishangupta-ds/architect): a `PreToolUse` hook
deterministically checks your plan against the team's recorded architectural
decisions before you're allowed to propose it. This is not a suggestion the model
can skip — the hook denies `ExitPlanMode` outright when the check fails.

## The loop

1. **Draft your plan** as you normally would in plan mode.
2. **Before calling `ExitPlanMode`**, submit it:
   - Preferred: call the `architect_submit_markdown_plan` MCP tool with your plan's
     markdown. It compiles into Architect's internal plan graph and returns a
     `planId` + `planHash`.
   - If the MCP tool isn't available for some reason, run
     `architect-submit.mjs <path-to-a-file-containing-your-plan-markdown>` instead
     (bin/ is on your PATH once the plugin is installed) — write your plan to a
     scratch file first if you don't already have one.
3. **Check it**: call `architect_check_plan` with the `planId` from step 2 (the
   `architect-submit.mjs` fallback already does this for you and prints the
   result).
4. **Read the report by severity**:
   - `violation` — blocks. You cannot propose this plan until every violation is
     either fixed or explicitly waived.
   - `risk` — does not block, but read it. It's telling you something a human
     reviewer will likely ask about.
   - `advisory` — informational, never blocks.
5. **binderStats matters**: if `binderStats.bound < binderStats.total`, the report
   is **INCOMPLETE**, not clean — some part of your plan wasn't matched to real
   code, so tiers that need that binding never ran on it. Say so explicitly to the
   user rather than reporting "0 violations" as if it were a clean pass. Consider
   whether the unbound label needs a clearer file path or symbol name.
6. **On a violation**, you have two honest options:
   - **Revise the plan** to no longer conflict with the cited decision, and
     resubmit with the **same `planId`** (this refines the existing plan rather
     than creating a duplicate — both `architect_submit_markdown_plan` and
     `architect-submit.mjs` do this automatically when reusing the same file/id).
     Re-check.
   - **Waive it**, only when the violation is a deliberate, understood exception:
     `POST /api/plans/:planId/waive {flagId, reason}` with a real, specific reason
     (never a placeholder like "approved" or "n/a" — the reason is what a human
     reviewer reads later to understand why this was allowed through). Re-check to
     confirm the waiver registered.
7. **Only once the check is clean (or every violation is waived) call
   `ExitPlanMode`.** The gate hook re-verifies this itself — it does not trust that
   you followed the loop, so there's no way to "forget" this step and have it slip
   through.

7a. **If `ARCHITECT_GATE=enforce-approvals` is set**, a clean plan is not
   automatically enough — the gate additionally requires a human reviewer to
   approve it before `ExitPlanMode` is allowed through:
   - A denial in this mode means the plan is clean but **awaiting reviewer
     approval**. The gate has already auto-requested reviews on your behalf if
     nothing was pending (you don't need to do this yourself). The deny reason
     names the exact next step: poll `GET /api/plans/<planId>/gate-status?wait=25&since=<fingerprint>`
     (or re-call `architect_get_gate_status`) until `reviewGate.satisfied` is
     `true`, then retry `ExitPlanMode`.
   - **Never approve your own plan.** The gate only auto-*requests* reviews; it
     never resolves them. Waiting for a real human to approve is the entire
     point of this mode — don't work around it by finding a way to self-approve.
   - If the deny reason says no reviewers could be auto-derived (no
     CODEOWNERS/decision/owner match found), **surface that to the user
     directly** and ask who should review this plan, rather than guessing —
     then send an explicit request yourself: `POST /api/plans/<planId>/reviews/request
     {from: ["their-login"]}`.
   - Against a server that predates this feature (`gate-status` 404s), the gate
     allows through with an upgrade note instead of blocking — you don't need to
     do anything differently there.

## Grounding your plan in recorded decisions

Before drafting, it's worth calling `architect_get_baseline` to see the currently
locked plans and the decision vocabulary the team actually uses — referencing a
real decision id in your plan's rationale (e.g. "per dec-014, this stays on the
sync path") produces citations Architect can actually resolve, which is what makes
a check report useful instead of generic.

## Rules

- **Never waive without a specific, substantive reason.** A vague waiver defeats
  the entire point of the gate — anyone reading it later needs to understand why
  the exception was granted.
- **Never mint a new `planId` on a retry.** Reuse the one from your first submit
  in this session so the history shows one plan being refined, not five unrelated
  drafts.
- **Never bypass the gate** (`ARCHITECT_GATE=warn`/`off`) unless the user
  explicitly asks you to, and say so out loud when you do — this is meant to be a
  deliberate, visible override, not something reached for out of impatience.
- If the gate denies your plan and you genuinely believe it's a false positive
  (e.g. a binder miss, or a decision that's actually stale), say that plainly to
  the user rather than silently working around it — the fix might be to the
  decision log or the binder, not the plan.
- **Under `enforce-approvals`, never approve your own plan and never poll in a
  tight loop.** Wait for the poll interval implied by `gate-status?wait=25` (one
  request every ~25s at most) rather than hammering the endpoint, and treat an
  `awaiting-approval` denial as "a human needs to act," not as a bug to route
  around.

## If the gate isn't configured

The `SessionStart` banner tells you whether the gate is active. If it says
"not configured", `ARCHITECT_URL`/`ARCHITECT_TOKEN` aren't set for this shell —
plan mode is running completely ungated. See this plugin's README for setup;
none of the steps above are mandatory until it's configured, though submitting
plans to Architect is still useful on its own (it's how the team's decision log
stays grounded in what's actually being built).
