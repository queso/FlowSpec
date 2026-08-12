# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased] - 2026-08-12

### Added

- **Pre-flight setup steps** (PRD-0006, #5): flows and config files can now declare a `setup` block — steps that run once, inside the flow's own browser session, immediately before its `steps`. This establishes state (most commonly, an authenticated session) that the rest of the flow depends on. (#767, #768, #770)
  - `setup` can be declared at the config level (`flowspec.config.yaml`, shared across every flow) or at the flow level. A flow-level `setup` **replaces** the config-level one entirely rather than merging with it, and an explicit `setup: []` on a flow opts it out of setup altogether — useful for a flow that specifically exercises the unauthenticated state. (#768, #770)
  - Setup steps run in the same browser session as the flow's own steps, so state such as cookies set during setup (e.g. visiting an auth-gated preview URL) is visible to everything that follows. (#770)
- **`${VAR}` interpolation in config files** (PRD-0006, #5): string values in `flowspec.config.yaml` (`baseUrl`, `specsDir`, and any string inside `setup`) may reference `${VAR_NAME}`, resolved from `process.env` at config-load time. This keeps tokens and secrets out of committed config. An unset variable is a hard error naming the variable and the config file path, raised before schema validation and before any browser session opens. Interpolation never runs on flow spec files under `specs/`. (#769)
  - Unset-variable detection uses `Object.hasOwn(process.env, varName)` rather than an `undefined` check, closing a prototype-collision bypass where identifiers like `constructor`, `toString`, `__proto__`, `hasOwnProperty`, `valueOf`, and `isPrototypeOf` would otherwise silently resolve to inherited `Object.prototype` values instead of throwing. (#769)
- **Setup-aware reporter output** (PRD-0006, #5): a failure during a setup step now renders as `Setup step N: <action>` (instead of `Step N: <action>`) in both `formatResult` and `formatError`, so it's visually distinct from a failure in the flow's own steps. Skipped flows render with a yellow `○ name (skipped)` marker and no step/error/duration output. `formatSummary` appends a `, N skipped` clause only when at least one flow was skipped. (#771)
- **Run-loop abort on shared setup failure** (PRD-0006, #5): the merged config's `setup` is now passed into every flow run. When a flow relying on that shared (config-level) setup fails during setup, the run aborts immediately and every remaining flow is reported as skipped, instead of repeating the same failure once per flow. A flow-level setup failure stays local — only that flow fails, and the run continues. A run where every flow has its own failing setup completes with every flow failed and none skipped, since no shared setup was involved. (#772)

### Changed

- Config files that fail to load or validate — including an unset `${VAR}` reference — now consistently exit with code **2** and print the underlying message without an `"Unexpected error:"` prefix, before any flow is parsed or browser session opened. Exit code **1** continues to mean flows ran and at least one failed; **0** means all flows passed. This is now documented explicitly in the README's exit code table. (#772, #773)
- `ateam.config.json`'s `unit` check now runs `bun run test` (the project's timeout-configured test script) instead of `bun test` directly, matching how CI and local development already run the suite.

### Documentation

- README: new "Setup: Shared Steps Before Every Flow" and "${VAR} Interpolation" sections under Configuration File, plus a "Setup (Optional)" section under Flow File Format, each with a worked auth-gated preview deployment example. (#773)
- `docs/specification.md`: the flow schema reference now lists `setup` as an optional flow field, so the spec format documentation no longer contradicts the shipped schema. (#773)
- Added ADRs recording the mission's key design decisions: skipped flows are represented as an ordinary `FlowResult` with a `skipped` flag rather than a new status enum (`adr/0001`); config faults (parse/validation/unset `${VAR}`) exit 2 (`adr/0002`); and `${VAR}` interpolation is scoped to committed config, not flow specs, keeping specs immutable (`adr/0003`).

### Internal

- `src/types.ts`: `FlowSpecSchema` gains an optional `setup: FlowStep[]`, `FlowErrorSchema` gains an optional `phase: "setup"` literal (when present, `FlowError.step` indexes into the setup array rather than `flow.steps`), and `FlowResultSchema` gains an optional `skipped: boolean`. `FlowSpecSchema` remains intentionally non-strict. (#767)
- `src/config.ts`: `FlowSpecConfigSchema` gains an optional `setup`, threaded through `mergeConfig`; added `${VAR}` interpolation over string config values (recursing into `setup`), applied before schema validation. (#768, #769)
- `src/runner.ts`: `runFlow` executes `setup` inside the flow's existing browser session before its steps loop, resolving precedence as `flow.setup ?? options.setup`; setup steps are not retried (retry stays scoped to assertions per PRD-0004). New fixtures `test/fixtures/pages/setup-auth.html` and `test/fixtures/pages/session-check.html` support a real-browser, cookie-based session-continuity test. (#770)
- `src/reporter.ts`: `formatError`/`formatResult` branch on `error.phase === "setup"`; `formatResult` short-circuits for `result.skipped` before any step/error/duration formatting; `formatSummary` counts skipped results separately from failed. (#771)
- `src/index.ts`: the run loop forwards the merged config's `setup` into every `runFlow` call and distinguishes config-level vs. flow-level setup failures to decide whether to abort and mark remaining flows skipped. (#772)

### Fixed

- Closed a prototype-collision bypass in `${VAR}` interpolation's unset-variable check (see "Added" above) found during review of #769.
