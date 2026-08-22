# Changelog

All notable changes to FlowSpec will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Pre-flight setup steps** (PRD-0006, #5): flows and config files can now declare a `setup` block — steps that run once, inside the flow's own browser session, immediately before its `steps`. This establishes state (most commonly, an authenticated session) that the rest of the flow depends on.
  - `setup` can be declared at the config level (`flowspec.config.yaml`, shared across every flow) or at the flow level. A flow-level `setup` **replaces** the config-level one entirely rather than merging with it, and an explicit `setup: []` on a flow opts it out of setup altogether — useful for a flow that specifically exercises the unauthenticated state.
  - Setup steps run in the same browser session as the flow's own steps, so state such as cookies set during setup (e.g. visiting an auth-gated preview URL) is visible to everything that follows.

- **`${VAR}` interpolation in config files** (PRD-0006, #5): string values in `flowspec.config.yaml` (`baseUrl`, `specsDir`, and any string inside `setup`) may reference `${VAR_NAME}`, resolved from `process.env` at config-load time. This keeps tokens and secrets out of committed config. An unset variable is a hard error naming the variable and the config file path, raised before schema validation and before any browser session opens. Interpolation never runs on flow spec files under `specs/`.
  - Unset-variable detection uses `Object.hasOwn(process.env, varName)`, so identifiers that collide with `Object.prototype` members — `constructor`, `toString`, `__proto__`, `hasOwnProperty`, `valueOf`, `isPrototypeOf` — raise the same hard error instead of silently resolving to an inherited value.

- **Config-level HTTP headers**: `flowspec.config.yaml` accepts an optional `headers` map, applied to each flow's browser session before that flow's `setup` and `steps` run, so every request the session makes carries them. This is the way past a deployment gated on a request header rather than a URL or login form (a Vercel protection-bypass token, a Netlify preview header, an `Authorization` header), and it composes with `setup` for navigation-based auth.
  - Header **values** support `${VAR}` interpolation, keeping the token out of the committed config; header **names** are never interpolated, since interpolation walks string values and never object keys. An unset variable is the same hard error as anywhere else in the config, naming the variable and the config file path before any browser session opens.
  - Headers are **origin-scoped by default**: they attach only to requests to `baseUrl`'s origin (same-origin subresources included) and never to cross-origin requests — a CDN, an analytics pixel, or an absolute `visit:` to another origin — so a bypass token is not handed to third parties. The new optional `headersScope: all` in `flowspec.config.yaml` is the opt-in escape hatch, restoring context-wide headers on every request to every origin for flows that legitimately span origins. Scoping matches by host and ignores scheme, following the underlying browser layer.
  - Repeatable **`--header "Name: value"` CLI flag** on `flowspec run`, so CI can pass the token on the invocation (alongside `--base-url`) instead of requiring the environment variable the config interpolates. The flags **replace** the config `headers` block entirely rather than merging per key — the same replacement rule a flow-level `setup` follows. Values are not `${VAR}`-interpolated, since the shell has already expanded them. A later flag for a name given earlier wins. A malformed argument (missing colon, or an empty name) prints a one-line error and exits with code **2**, before any flow is parsed or any browser session opens. `headersScope` has no CLI equivalent.
  - **Header validation up front**: header names that are not valid HTTP tokens, and values containing NUL, carriage return, or line feed, are rejected by FlowSpec itself before any browser command is issued, reported as the standard `Failed to apply headers: ...` failure naming the offending header. Necessary rather than defensive: under origin scoping, the browser layer hangs on a bad header name instead of erroring.
  - `headers` is config-level only — there is no flow-file `headers` block. Header auth is an environment concern rather than app behavior, so it stays out of the immutable `specs/**` surface (`adr/0003`).
  - Because the headers are shared by every flow, a failure applying them aborts the run: that flow fails with a `Failed to apply headers: ...` error and every remaining flow is reported as skipped — the same contract as a config-level `setup` failure.

- **Setup-aware reporter output** (PRD-0006, #5): a failure during a setup step now renders as `Setup step N: <action>` (instead of `Step N: <action>`) in both `formatResult` and `formatError`, so it's visually distinct from a failure in the flow's own steps. Skipped flows render with a yellow `○ name (skipped)` marker and no step/error/duration output. `formatSummary` appends a `, N skipped` clause only when at least one flow was skipped.

- **Run-loop abort on shared setup failure** (PRD-0006, #5): the merged config's `setup` is now passed into every flow run. When a flow relying on that shared (config-level) setup fails during setup, the run aborts immediately and every remaining flow is reported as skipped, instead of repeating the same failure once per flow. A flow-level setup failure stays local — only that flow fails, and the run continues. A run where every flow has its own failing setup completes with every flow failed and none skipped, since no shared setup was involved.

- **`--dir` flag for `flowspec init`** (PRD-0005)
  - `flowspec init --dir apps/web` initializes FlowSpec in a specific directory
  - Creates the target directory if it doesn't exist
  - Supports both relative and absolute paths

- **Monorepo detection**
  - `detectMonorepoMarkers(dir)` checks for `pnpm-workspace.yaml`, `turbo.json`, `nx.json`, and `workspaces` in `package.json`
  - Advisory warning when monorepo markers are found, suggesting `--dir` to target a specific package
  - Skips detection entirely when no `package.json` is present

- **Existing setup detection**
  - `findExistingSetup(dir)` searches upward for `flowspec.config.yaml` and one level down for `specs/*.flow.yaml`
  - Init output reports existing config and specs locations when found

- **Enhanced init output**
  - Shows target directory path
  - Displays monorepo warnings with detected markers
  - Reports nearby existing FlowSpec configuration and specs directories

- **CLI surface adapter** (PRD-0007): a flow can now declare `surface: cli` and drive a command-line tool instead of a browser — no `agent-browser` involved, and a CLI-only project doesn't need it installed at all. A flow with no `surface` key, or an explicit `surface: web`, parses and runs exactly as before; the entire existing web test suite passed unmodified throughout this mission. Mixing web and CLI verbs in one flow is a parse error naming the offending verb and the flow's surface (#800, #812).
  - **CLI step grammar**: `run` (a whitespace-split string or an untouched array), plus optional `stdin`, `env`, `timeout`, and `expect_exit` (#800).
  - **No-shell process execution** (`src/exec.ts`): commands are spawned directly via argv — never through a shell — so shell interpolation is structurally impossible rather than filtered or escaped. A hung command is killed (`SIGTERM`, escalating to `SIGKILL`) at its timeout, and stdout/stderr are captured independently up to a configurable byte limit, with truncation made visible (#801, #806).
  - **Surface-agnostic matchers** (`src/matchers.ts`): reusable `contains`, `regex`, and dot-path JSON comparison, reporting structured failures instead of throwing (#802).
  - **Retryable file matchers** (`src/file-matchers.ts`): file-existence and file-content checks that poll within the flow's timeout, for files an async process may still be writing (#803).
  - **Per-flow working directory** (`src/workdir.ts`): each CLI flow gets a fresh temporary directory, deleted on success and kept (with its path printed in the failure report) on failure — the CLI analog of the web surface's failure screenshot (#804).
  - **Eight CLI assertions**: `exit_code`, `stdout_contains`, `stdout_matches`, `stderr_contains`, `stderr_matches`, `file_exists`, `file_contains`, and `json_output`, evaluated against the last run step's captured result (`src/cli-assertions.ts`), plus widened `FlowError` fields carrying exit code, stdio excerpt, and working directory (#805, #809).
  - **CLI runner** (`src/cli-runner.ts`): fail-fast exit-code semantics — a non-final step's exit code must match its `expect_exit` (default 0) or the flow fails immediately, while the final step's exit code is only fatal if it declares its own `expect_exit`, making "this command should fail" a first-class spec. A CLI flow can also declare its own flow-level `setup` phase, in the same grammar, run before `steps` in the same working directory; a setup failure is reported as a setup failure, not a step failure (#808, #811).
  - **`runFlow` dispatches on surface** (`src/runner.ts`): the CLI path never resolves or launches a browser (#812).
  - **Reporter renders CLI failures** (`src/reporter.ts`) alongside web failures in one summary, naming the command, its exit code, and what its output actually was (#810).
  - **Config gains `cwd` and `captureLimit`** (`src/config.ts`): CLI-surface-only config keys — a configured working directory and an output capture limit — that now survive the CLI merge instead of being silently dropped; both are ignored by web flows, and config-level `setup` stays web-only (#807).

- **Dogfooding**: FlowSpec now specs its own `flowspec init` command. `specs/init.flow.yaml` is a protected, human-authored `surface: cli` spec (the repo's own PreToolUse hook blocks agent edits to `specs/**/*.flow.yaml` — see `adr/0005`) exercised by `bun run test:e2e`, which builds the CLI, links the `flowspec` binary, and runs the specs directory — locally and now as a CI step. This is the first time `test:e2e` has passed (#815, #816).

### Changed

- Config files that fail to load or validate — including an unset `${VAR}` reference — now consistently exit with code **2** and print the underlying message without an `"Unexpected error:"` prefix, before any flow is parsed or browser session opened. Exit code **1** continues to mean flows ran and at least one failed; **0** means all flows passed. This is now documented explicitly in the README's exit code table.

### Fixed

- **Quote fidelity in browser commands**: every `agent-browser` invocation now passes an argument array straight to the process instead of building a shell command string, so no shell is involved and the hand-rolled quoting is gone. Values containing quotes — header values, `fill` text, URLs — round-trip verbatim instead of arriving with escaping artifacts.

### Documentation

- README: new "Setup: Shared Steps Before Every Flow" and "${VAR} Interpolation" sections under Configuration File, plus a "Setup (Optional)" section under Flow File Format, each with a worked auth-gated preview deployment example.
- `docs/specification.md`: the flow schema reference now lists `setup` as an optional flow field, so the spec format documentation no longer contradicts the shipped schema.
- Added ADRs recording the mission's key design decisions: skipped flows are represented as an ordinary `FlowResult` with a `skipped` flag rather than a new status enum (`adr/0001`); config faults (parse/validation/unset `${VAR}`) exit 2 (`adr/0002`); and `${VAR}` interpolation is scoped to committed config, not flow specs, keeping specs immutable (`adr/0003`).

- **CLI surface documentation** (#814): README gains a new "CLI Flows (`surface: cli`)" section — step grammar, the no-shell rule and its two escape hatches, all eight assertions, working-directory semantics, CLI-flow `setup`, and the `expect_exit` fail-fast/final-step rule — plus a `cwd`/`captureLimit` subsection under Configuration File. `docs/specification.md` gets the matching schema reference, a full worked example, and simplified CLI-runner-dispatch pseudocode under Execution Modes.
- Added ADRs recording this mission's key design decisions: `expect_exit` is honored on every step, but only the final step's *absence* of `expect_exit` makes its exit code non-fatal (`adr/0004`); protected specs such as `specs/init.flow.yaml` are drafted outside `specs/` and moved in by a human, since the repo's own PreToolUse hook blocks agent writes there (`adr/0005`); and `specsDir`-based path discovery for `flowspec run` stays out of scope for this mission (`adr/0006`).

## [0.1.2] - 2026-02-20

### Fixed

- CLI shebang changed from `#!/usr/bin/env bun` to `#!/usr/bin/env node` so the published package runs without requiring Bun
- Switched to `NodeNext` module resolution with `.js` import extensions so `tsc` output is valid Node ESM
- Access `Bun` global safely via `globalThis` to avoid `ReferenceError` under Node.js — the `execFileSync` fallback now works correctly

## [0.1.1] - 2026-02-12

### Fixed

- Fix Claude Code hook format in `flowspec init` to use correct `command_name[]` array schema with `{ matcher, hooks: [{ type, command }] }` instead of the old `{ matcher: { tool, path }, command }` format
- `flowspec init` now merges the FlowSpec protection hook into existing `.claude/settings.local.json` instead of skipping the file entirely, so users who already ran init get the corrected hook on re-init

### Added

- Export `FLOWSPEC_HOOK_MARKER` and `FLOWSPEC_PRETOOLUSE_HOOK` constants from `src/init.ts`
- New `merged` field on `InitFileResult` to indicate when a hook was merged into existing settings (vs created or skipped)
- Graceful handling of unparseable `.claude/settings.local.json` (file is preserved, init reports skipped)

## [0.1.0] - 2026-02-07

### Added

- **`flowspec init` Command**
  - Scaffolds new FlowSpec projects with `flowspec init`
  - Creates `flowspec.config.yaml` with default settings
  - Creates `specs/` directory with example flow
  - Sets up `.claude/settings.local.json` with PreToolUse hook to protect specs from AI modification
  - Updates `package.json` with `test:e2e` script

- **Config File Support**
  - `flowspec.config.yaml` for project-level configuration
  - Settings: `baseUrl`, `timeout`, `specsDir`
  - CLI options override config file values
  - Config file discovery walks up directory tree

- **`wait_for` Step Type**
  - New step action: `wait_for: "Text"` waits for text to appear before continuing
  - Uses same retry/polling logic as assertions (respects `--timeout`)
  - Useful for async UI updates (e.g., waiting for AI responses, loading states)

- **Assertion Retry/Polling** (PRD-0004)
  - Assertions now auto-retry on failure until pass or timeout elapses
  - `--timeout <ms>` CLI flag to configure retry timeout (default: 5000ms)
  - `timeout` option in `RunnerOptions` for programmatic control
  - All assertion types (`visible`, `not_visible`, `matches`, `url`) support retry
  - `timeout: 0` disables retries for instant failure (useful for tests)
  - New constants: `DEFAULT_TIMEOUT` (5000ms), `POLL_INTERVAL` (250ms)

- **FlowSpec CLI** (PRD-0002)
  - `flowspec run <path>` command to execute flow specifications
  - `--base-url <url>` option for configuring the target server
  - Exit codes: 0 (pass), 1 (fail), 2 (parse error)

- **YAML Parser** (`src/parser.ts`)
  - `parseFlowSpec(yaml)` - Parse YAML string to FlowSpec object
  - `parseFlowFile(path)` - Parse flow file from disk
  - Zod schema validation with human-readable error messages
  - YAML syntax error reporting with line/column information

- **Result Reporter** (`src/reporter.ts`)
  - `formatResult(result)` - Format single flow result with colors
  - `formatSummary(results)` - Format summary of all results
  - `formatError(error)` - Format error details with step context
  - ANSI color output (green checkmark for pass, red X for fail)

- **Flow Runner** (`src/runner.ts`)
  - `runFlow(flow, options)` - Execute a FlowSpec with browser automation
  - Browser automation via `agent-browser` CLI
  - Step actions: visit, click, fill, select
  - Assertions: url, visible, matches, not_visible
  - Isolated browser sessions per flow execution
  - Shell escaping for secure command execution

- **Biome linter and formatter** (`biome.json`)
  - Fast Rust-based linting and formatting
  - Replaces ESLint + Prettier with single tool
  - Scripts: `lint`, `lint:fix`, `format`

- **Project infrastructure** (PRD-0001)
  - Bun/TypeScript project with strict configuration
  - Vitest test runner with coverage support
  - Express-based test fixture server for E2E testing

- **Core type definitions** (`src/types.ts`)
  - `FlowSpec` - Complete flow specification schema
  - `FlowStep` - Individual step actions (visit, click, fill, select)
  - `StepAssertion` - Assertion types (url, visible, matches, not_visible)
  - `FlowResult` - Execution result with timing and errors
  - `FlowError` - Structured error information
  - All types use Zod for runtime validation

- **Test fixtures**
  - HTML pages: login, dashboard, forms (for browser testing)
  - YAML flows: valid and invalid examples (for parser testing)

- **Test infrastructure**
  - Test fixture server with start/stop lifecycle
  - 111+ tests covering parser, reporter, CLI
