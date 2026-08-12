# ADR 0001: Skipped flows are a FlowResult flag, not a status enum

**Status:** Accepted
**Date:** 2026-08-12
**Deciders:** Face + Sosa (mission: PRD-0006 Pre-Flight Setup Steps)

## Context

PRD-0006 aborts a run when a shared, config-level `setup` block fails, and reports the
flows that never executed as *skipped*. That introduces a third run state alongside
passed and failed (FR-9, FR-11), which `FlowResult` had no way to express.

The obvious modeling answer is a discriminated `status` field. The obvious answer is not
the one we took, and the reason is not visible from `types.ts` alone — which is why it is
recorded here.

## Decision

A skipped flow is an ordinary `FlowResult` carrying `success: false` plus an additive
optional boolean:

```ts
skipped: z.boolean().optional()
```

`FlowResultSchema` keeps `success` as its primary signal. Nothing is removed or renamed.

## Alternatives Considered

- **`status: "passed" | "failed" | "skipped"` as a discriminated union.** Cleaner in
  isolation and the better model on a blank sheet. Rejected because `src/index.ts`
  computes the process exit code from `results.every(r => r.success)`, and PRD-0006 FR-15
  requires that flows configuring no setup behave byte-identically to today. Replacing
  `success` would touch the exit-code path, the reporter, and every existing result
  assertion in the test suite — a wide blast radius bought for a state that only exists
  during an aborted run.
- **A separate skipped counter threaded into `formatSummary`.** Rejected because the
  count would then live outside the results array, and every future consumer of results
  would have to be told about the second channel.

## Consequences

Skipped flows are counted as not-successful, so an aborted run exits 1 with no change to
the exit-code expression. `formatSummary` must derive `failed` from an explicit predicate
rather than `total - passed`, or skipped flows are silently miscounted as failures.

Any future result state — retried, flaky, expected-failure — inherits this constraint and
should extend the same additive way until someone is prepared to migrate the exit-code
coupling deliberately. Do not re-propose the enum without addressing
`results.every(r => r.success)` first; that coupling is the whole reason it lost.
