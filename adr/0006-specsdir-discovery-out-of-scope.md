# ADR 0006: `specsDir`-based discovery stays out of scope for PRD-0007

**Status:** Accepted
**Date:** 2026-08-18
**Deciders:** Face + Sosa (mission: PRD-0007 CLI Surface Adapter)

## Context

PRD-0007 requires the dogfood spec to run in CI. Wiring that up surfaced a gap that
predates this mission: `specsDir` is declared in `FlowSpecConfigSchema`, loaded,
validated, and interpolated — and then never read by anything. `discoverFlowFiles`
(`src/index.ts`) works purely from the path argument, and `flowspec run` with no path
exits 1 with "No path specified".

The tempting fix is to make `flowspec run` fall back to `specsDir` when no path is
given. That would also repair `flowspec init`'s scaffolded `test:e2e` script, which is
a bare `flowspec run` and therefore exits 1 for every user who runs it.

## Decision

Discovery via `specsDir` is deliberately NOT implemented in PRD-0007. The `test:e2e`
script passes an explicit path (`flowspec run specs/`).

The root `flowspec.config.yaml` this mission adds still declares `specsDir: specs/` —
as dogfooding and as documentation of the config surface, not as a discovery mechanism.

## Alternatives Considered

- **Implement the `specsDir` fallback here.** Rejected: unrequested scope in a mission
  already spanning the type layer, a new spawn primitive, the runner, the reporter, and
  the config. It changes the behavior of every existing `flowspec run` invocation — a
  meaningful CLI contract change that deserves its own decision, not a ride-along on a
  surface adapter.
- **Drop `specsDir` from the config schema as dead weight.** Rejected: it is documented
  and scaffolded, so removing it is a breaking change to every existing project's
  config for no gain within this mission.

## Consequences

`specsDir` remains load-bearing in documentation and inert in behavior until a mission
takes it on deliberately. Anyone reading the config schema should know it is not yet
consumed.

The related `flowspec init` scaffold bug (a `test:e2e` script that cannot succeed) is
filed separately: fixing it changes init's scaffolded output and `test/init.test.ts`,
so it belongs with whichever mission takes on discovery, not with this one. These two
should be resolved together — the fallback is what makes the scaffolded script correct.
