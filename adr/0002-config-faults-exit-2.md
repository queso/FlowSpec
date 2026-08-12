# ADR 0002: Config load and validation faults exit 2 with a clean message

**Status:** Accepted
**Date:** 2026-08-12
**Deciders:** Face + Sosa (mission: PRD-0006 Pre-Flight Setup Steps)

## Context

PRD-0006 requires an unset `${VAR}` in `flowspec.config.yaml` to fail before any browser
session opens (FR-13), naming the missing variable (NFR-3). Reviewing where that error
would actually surface exposed an inconsistency that predates this PRD:

- `parseFlowFiles` failures print a clean message and `process.exit(2)`.
- `loadConfig()` is not wrapped at all, so a malformed or invalid config falls through to
  `main().catch` and prints `Unexpected error: Invalid configuration: ...` with exit 1.

So the two ways a run can be misconfigured before it starts reported themselves
differently, and one of them read like a crash.

## Decision

Config load and validation faults join the parse-error contract: the underlying message
is printed to stderr without the `Unexpected error:` prefix, and the process exits 2. The
`loadConfig` / `mergeConfig` block in `src/index.ts` is wrapped to make this so.

This fixes the general case rather than the interpolation case. An unset `${VAR}` rides
on it automatically once interpolation ships, because it is just another config load
failure.

## Alternatives Considered

- **Leave the exit-1 fall-through.** Smallest diff, but a user error keeps presenting as
  an internal crash, and CI cannot distinguish "your config is wrong" from "your app is
  broken."
- **Special-case exit 2 for interpolation errors only.** Rejected as arbitrary: a missing
  environment variable and a malformed `timeout` are the same class of problem and should
  not exit differently.

## Consequences

The exit codes now carry a stable meaning worth preserving:

| Code | Meaning |
|------|---------|
| 0 | All flows passed |
| 1 | Flows ran and one or more failed |
| 2 | Misconfigured — nothing ran |

Every future pre-flight validation gate belongs in the exit-2 bucket. CI consumers can
treat 2 as "fix your setup, no test signal was produced" and 1 as a real test signal, so
moving a pre-flight check to exit 1 later would be a breaking change to that contract.
