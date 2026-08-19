# ADR 0005: Protected specs are drafted outside `specs/` and moved in by a human

**Status:** Accepted
**Date:** 2026-08-18
**Deciders:** Face + Sosa (mission: PRD-0007 CLI Surface Adapter)

## Context

PRD-0007 ships FlowSpec's first dogfood spec: `specs/init.flow.yaml`, covering
`flowspec init`. This repo already installs its own PreToolUse hook (in
`.claude/settings.local.json`), which blocks any Edit or Write whose `file_path`
matches `specs/**/*.flow.yaml`.

So the mission's deliverable is a file the implementing agent is forbidden to create —
the immutability guarantee working exactly as designed, aimed at us. Every repo that
installs the hook and later wants a new protected spec hits this, so it needs an answer
that is not "handle it ad hoc this once."

## Decision

The agent drafts the spec at a path outside the protected glob (`spec-drafts/init.flow.yaml`),
writes its parse test against that draft path, and stops with a request for the human to
review and `git mv` the file into `specs/`. The test is then repointed at the final path.

The hook is never lifted, and the agent never routes around it.

## Alternatives Considered

- **A human authors the spec from scratch.** Rejected: throws away the agent's
  translation of acceptance criteria into flow steps, which is the expensive part. The
  human's judgment is needed for *review and admission*, not transcription.
- **Temporarily disable the hook for the duration of the item.** Rejected: the
  guarantee is off precisely while a spec is being written — the window when it matters
  most. It also normalizes lifting the hook as a routine step.
- **`git mv` or `cp` from Bash, by the agent.** Rejected, and explicitly forbidden in
  the item's context. The hook matches only Edit/Write `file_path`, so a shell move
  bypasses it silently. An agent that learns this move has learned to defeat the
  guarantee the product sells.

## Consequences

Protected specs get a human admission step by construction: agents propose, humans
admit. That is the intended shape of the trust boundary, not a workaround for it.

Any mission adding a spec to a hook-installing repo inherits this flow, so plan for a
human handoff mid-item rather than an uninterrupted agent run. The draft directory
(`spec-drafts/`) should stay out of the protected glob and should not accumulate stale
drafts — a merged draft is deleted, not left behind.

The silent-bypass property of the hook (Edit/Write only, not Bash) is worth knowing
independently: it means the hook is a guardrail for well-behaved tools, not a security
boundary.
