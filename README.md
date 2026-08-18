# architect (Claude Code plugin)

Deterministically gates Claude Code plan mode against
[Architect](https://architect.intutic.ai), an architecture-decision copilot: before a
plan can be proposed, it is submitted, checked against recorded decisions, and any
unwaived violation blocks `ExitPlanMode` until resolved or explicitly waived. See
[ishangupta-ds/architect](https://github.com/ishangupta-ds/architect) for the server
this plugin talks to.

Setup instructions and the full workflow are documented in the
[`architect-workflow` skill](skills/architect-workflow/SKILL.md) and this repo's
own docs (filled in as the plugin is built out — see `DEV_NOTES.md` for build status).
