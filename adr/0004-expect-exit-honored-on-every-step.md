# ADR 0004: expect_exit is honored on every step, including the final one

**Status:** Accepted
**Date:** 2026-08-18
**Deciders:** Face + Sosa (mission: PRD-0007 CLI Surface Adapter)

## Context

PRD-0007 establishes two rules that collide on one step. Non-final `run` steps fail
fast: a step whose exit code differs from its `expect_exit` (default 0) fails the flow
there, so a broken command never produces a misleading assertion failure three steps
later. The final `run` step's exit code, by contrast, is "pure assertion territory" —
it never fails the flow on its own, which is what makes error-path specs (`bad flag
exits 1 and names the flag on stderr`) first-class.

The collision: what happens when the *final* step carries an explicit `expect_exit`?
The two rules give opposite answers, and the PRD does not say which wins.

## Decision

`expect_exit` is enforced wherever it appears, including on the final step. A final
step declaring `expect_exit: 1` and exiting 1 proceeds to assertions; the same step
exiting 0 fails the flow at that step.

Only the **absence** of `expect_exit` makes the final step's exit code non-fatal. An
explicit `expect_exit` is a declaration by the spec author, not an instance of
"failing on exit code alone."

## Alternatives Considered

- **Parse error on `expect_exit` on the final step.** Rejected: makes a step's legal
  modifiers depend on its position in the list, so adding a step at the end silently
  invalidates the one before it. Position-dependent grammar is the kind of surprise
  that costs more than the ambiguity it removes.
- **Silently ignore `expect_exit` on the final step.** Rejected: a spec would state an
  expectation that never runs — exactly the class of hazard (assertions that look
  enforced but aren't) this PRD exists to eliminate.

## Consequences

The rule to document and teach is "`expect_exit` always means what it says; the final
step is special only when you say nothing." This is the least guessable rule in the CLI
grammar, so it carries its own documentation criterion in the docs item.

Surfaces #7 (Conduit) and #8 (API) inherit this step grammar. They should adopt the
same rule rather than re-deciding it per surface — a per-surface answer would make
`expect_exit` mean different things in specs that otherwise read identically.
