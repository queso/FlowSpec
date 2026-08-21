---
missionId: ~
---

# PRD-0007: CLI Surface Adapter

**Author:** Josh
**Date:** 2026-08-16
**Status:** Draft
**Issue:** https://github.com/queso/FlowSpec/issues/6

## Executive Summary

FlowSpec's immutable-spec guarantee currently exists for exactly one surface: web flows
driven through agent-browser. This PRD adds `surface: cli` so a spec can run a command and
assert on its exit code, stdout/stderr, and the files it writes — using the same YAML
grammar, parser, reporter, and PreToolUse immutability hook. It is deliberately the first
of three surface adapters (CLI, then Conduit #7, then API #8): the simplest surface pays
the one-time cost of making FlowSpec multi-surface, and it lets FlowSpec spec its own CLI
as the first consumer.

## Definition of Done

<!-- Filled by Face during planning; blessed at the refinement gate. -->

- [ ]
- [ ]
- [ ]

## 1. Context & Background

FlowSpec exists to close one hole: when a spec fails, agents fix the implementation, not
the spec — because the spec is protected and the test code is not. Today that guarantee is
only available to web apps. Every CLI-surface repo in the fleet (this repo itself,
bambu-cloud-bridge, promptdiff, the decker CLI, the ateam CLI) keeps its
definition-of-done in mutable test files, which is exactly the "agent fixes the test
instead of the bug" hole FlowSpec was built to close.

This is part of the multi-surface substrate plan (theaiteam-dev/the-ai-team-plugin#51,
PRD 010): one immutable `steps`/`expect` grammar, per-surface adapters, one graduation
pipeline (DoD → protected spec → CI) feeding the earned-auto-merge ladder.

CLI goes first, ahead of the Conduit adapter (#7), for three reasons:

- **The first adapter pays the architecture tax.** Whichever surface goes first introduces
  the `surface` discriminator, per-surface step/assertion schemas, and runner dispatch.
  Those decisions should be made against the simplest surface, not entangled with the
  Conduit kernel's output conventions.
- **The plumbing is a close cousin of something that already exists.** `execCommand`
  (`src/runner.ts:112`) already spawns a process with captured stdout/stderr/exit code,
  with a Bun-native path and a Node fallback — but it hardcodes stdin to `ignore` and has
  no `cwd`/`env` support, so it can't be reused as-is. The CLI runner introduces a sibling
  primitive, `spawnProcess` (`src/exec.ts`), built on the same Bun-native/Node-fallback
  pattern; the CLI runner itself is mostly schema and assertions, not new execution
  machinery.
- **Conduit is roughly a specialization of CLI.** `run_flow` is "run a command"; `env`,
  `file_exists`, and JSON-file assertions appear in both proposals. Landing CLI first
  means #7 inherits most of its machinery.

## 2. Problem Statement

A team shipping a CLI tool has no way to state, immutably, what a green run of that tool
means. The FlowSpec grammar has no verb for "run this command" and no assertions over exit
codes, stdio, or produced files — and the runner unconditionally drives a browser.
FlowSpec cannot even spec its own `flowspec init`, so the tool that enforces
protected-spec discipline on other repos has none of its own.

## 3. Target Users & Use Cases

**Primary users:**

- **CLI tool maintainers** running agent-driven development, who need a
  definition-of-done that agents cannot quietly weaken.
- **FlowSpec itself** — the first consumer; `flowspec init` behavior becomes a protected
  spec running in this repo's CI.

**Key use cases:**

- A maintainer needs to spec "`flowspec init` scaffolds config, a sample spec, and the
  protection hook" so that scaffolding regressions fail CI against a spec no agent edits.
- A maintainer needs to spec an *error path* ("bad flag exits 1 and names the flag on
  stderr") so that error behavior is a contract, not an accident — which requires nonzero
  exit codes to be assertable rather than treated as failures.
- A maintainer needs specs to run in a fresh working directory per flow so that runs are
  deterministic and parallelizable, and a spec can't pass by luck of leftover state.
- An agent-driven repo owner needs web and CLI specs to live in the same `specs/` tree
  under the same hook and produce one unified report.

## 4. Goals & Success Metrics

| Goal | Metric | Target |
|------|--------|--------|
| Establish the multi-surface architecture | Existing web flows and tests | Pass unchanged; specs with no `surface` field behave identically |
| FlowSpec specs itself | A protected `flowspec init` spec in this repo's CI | Green in CI |
| Cover the issue-#6 grammar | The sketch in issue #6 | Expressible and passing verbatim (modulo paths) |
| No browser dependency for CLI runs | A CLI-only run on a machine without agent-browser | Completes without attempting to launch a browser |
| Legible failures | Failed CLI assertion output | Includes exit code and a bounded stderr/stdout excerpt |

## 5. Scope

### In Scope

- An optional `surface` field on flow files: `web` (default when absent) or `cli`
- CLI step grammar: `run` (command as string or argv array) with optional per-step
  `stdin`, `env`, and `timeout` modifiers; multiple `run` steps per flow
- CLI assertions: `exit_code`, `stdout_contains`, `stdout_matches`, `stderr_contains`,
  `stderr_matches`, `file_exists`, `file_contains: {path, text}`,
  `json_output: {path, equals}`
- A fresh temporary working directory per CLI flow; config-level `cwd` override
- Flow-level `setup` in CLI flows, using CLI steps (e.g. seeding files before the run)
- Runner dispatch on `surface`; the CLI path never touches agent-browser
- Reporter rendering for CLI steps and assertions, unified summary across surfaces
- Parse-time rejection of surface/verb mismatches (web verbs in a CLI flow and vice versa)
- A dogfood spec for `flowspec init` in this repo's `specs/`, running in CI
- Documentation: README and `docs/specification.md`

### Out of Scope

- **Shell features** — pipes, redirects, globbing, `&&` chains. Commands are spawned
  directly, no shell. See Design.
- **Interactive processes / PTY emulation** — `stdin` is write-then-close only.
- **`${VAR}` interpolation inside `specs/**`** — already decided in ADR-0003; specs stay
  literal on every surface.
- **The Conduit (#7) and API (#8) surfaces** — they build on this; nothing here should
  preclude them, but their verbs ship separately.
- **Parallel flow execution** — per-flow tmp dirs make it *possible* later; scheduling is
  its own feature.
- **Snapshot / golden-file assertions** — `file_contains` and `json_output` cover current
  needs; snapshots bring update-workflow questions that deserve their own PRD.
- **Config-level `setup` for CLI flows** — config-level setup remains web-surface setup;
  see Design.

## 6. Design

### The surface discriminator

`FlowSpecSchema` (`src/types.ts`) gains an optional `surface` enum. Absent means `web`,
so every existing spec file is untouched and means what it meant yesterday. The
steps/assertions a flow may use are determined by its surface: parsing a CLI flow
validates steps against the CLI step schema and `expect` against the CLI assertion
schema. A web verb in a CLI flow (or vice versa) is a parse error, reported before
anything executes, with the same exit-2 semantics parse errors already have (ADR-0002).

Two silent-ignore hazards, both instances of the class PRD-0006 documented:

- `FlowSpecSchema` is not `.strict()` at the top level, so `surface` must be a real
  schema field — otherwise a `surface: cli` flow would silently run as a web flow.
- An *older* flowspec binary given a CLI spec would drop the unknown `surface` key and
  fail bizarrely trying to browse. Nothing to build here — but the docs should note the
  minimum version next to the feature.

### Step grammar: `run`, no shell

A CLI step is a `run` with optional modifiers:

```yaml
steps:
  - run: "flowspec init --dir ./proj"
  - run: ["badcmd", "--provoke-error"]
    expect_exit: 1
  - run: ["flowspec", "run", "--flow", "spec with spaces.flow.yaml"]
    env: { NO_COLOR: "1" }
    stdin: "y\n"
    timeout: 5000
```

Commands are spawned directly with an argv array — **no shell**. This repo just moved
browser execution to args-array spawning for exactly this reason: no quoting bugs, no
injection surface, no platform-dependent shell semantics. The string form is split on
whitespace as a convenience; arguments containing spaces require the array form. This
limitation is documented rather than papered over with quoting rules.

Consequences accepted: no pipes or redirects in specs. A spec that needs a pipeline is
specifying a shell script's behavior — wrap it in a script and `run` that.

- `env` overlays the inherited process environment for that step. Values are literal
  (ADR-0003: specs never interpolate).
- `stdin` is written to the child and the stream closed — sufficient for confirmation
  prompts, not for interaction.
- `stepTimeout` bounds the step; on expiry the process is killed and the step fails with a
  timeout error. Default comes from the config `stepTimeout` (60s), a key distinct from
  the assertion-retry `timeout` — the two clocks measure different things and the config
  key names them separately.

### Execution model: fresh cwd per flow

Each CLI flow runs in a freshly created temporary directory — deleted when the flow
passes, kept (with its path printed in the failure report) when it fails. The kept
directory is the CLI analog of the web surface's failure screenshot: `file_contains`
failures beg the question "so what *is* in that file?", and the evidence from the run
that actually failed is worth more than tidy tmp space, which the OS reaps anyway.

The fresh directory itself plays the role the fresh browser session plays for web: no
state leaks between flows, runs are deterministic, and future parallelism is not
precluded. A
config-level `cwd` can override it for tools that must run inside a real checkout — at
the cost of determinism, which is the user's call to make, in the mutable config file,
outside the immutable spec.

Relative paths — in `file_exists`, `file_contains`, and `run` commands' arguments — are
resolved by the child process and the assertion checker against this cwd, so the sketch
in issue #6 can say `file_exists: proj/flowspec.config.yaml` without absolute paths.

### Assertion semantics

Assertions evaluate after all steps complete, against **the last `run` step's** captured
output. Multi-step flows are chains ("init, then run, assert on the run"), and the final
state is what the spec is about. Intermediate steps' output is not addressable in v1.

Exit codes are handled differently for the final step and the steps before it:

- **The final step's exit code is pure assertion territory.** `exit_code` is an
  assertion like any other, because error-path specs ("bad flag exits 1") are
  first-class. The final step never fails on its exit code alone.
- **Non-final steps fail fast.** A non-final `run` step must exit 0, or the flow fails
  at that step, with that step's stderr — pointing at the root cause instead of letting
  a later step fail confusingly in a broken world. This is the same misleading-failure
  reasoning PRD-0006 applied to web setup. A per-step `expect_exit: <n>` modifier
  declares an intermediate command that is *supposed* to fail, keeping error-state
  chains expressible.

Retry semantics extend the PRD-0004 model by what retrying can actually change:

- `exit_code`, `stdout_*`, `stderr_*`, `json_output` are **final** — the process has
  exited; its output cannot change. One evaluation, no retry.
- `file_exists` and `file_contains` **retry within the timeout window**, because a
  just-exited process may have async writers (a spawned daemon, a flushing logger) still
  completing. Same model, same timeout source as web assertion retry.

`json_output` parses the last step's stdout as JSON and compares at a dot-path
(`$.foo.bar`). Non-JSON stdout is an assertion failure that says so, with the head of
the offending output — not a crash.

### Runner dispatch, reporting, and what stays shared

`runFlow` (`src/runner.ts:709`) branches on surface before any session exists. The web
path is untouched. The CLI path builds on `spawnProcess` (`src/exec.ts`) and never
resolves, launches, or requires agent-browser — a CLI-only run must work on a box where
it isn't installed.

Everything around the runner stays shared: one parser, one reporter, one `FlowResult`
stream, one summary (`formatSummary`) across a mixed-surface run, one PreToolUse hook
protecting `specs/**` regardless of surface. `FlowError` gains nothing surface-specific
except that `screenshot` is simply never set; failure reports instead carry the exit
code and a bounded excerpt of stdout/stderr, because "which assertion failed" without
"what the process actually printed" sends the user straight to re-running by hand.

The assertion primitives this PRD introduces — contains/matches text checks, path-based
JSON comparison, retryable file checks — are precisely what the Conduit (#7) and API
(#8) adapters consume next. They should land as surface-agnostic machinery, not
CLI-runner internals; that is a strategy constraint, not an implementation prescription.

### Setup interplay with PRD-0006

Config-level `setup` is a sequence of *web* steps that plants browser state; it has no
meaning for a process spawn. So: config-level setup applies to web flows only, CLI flows
skip it, and its failure-abort semantics (PRD-0006) continue to govern the run
unchanged. A CLI flow may declare its own flow-level `setup` of CLI steps — the natural
place to seed fixture files — with PRD-0006's phase-labeled error reporting intact.

## 7. Requirements

### Functional Requirements

1. `FlowSpecSchema` shall accept an optional `surface` field with values `web` and
   `cli`; absent shall mean `web`.
2. A flow with `surface: cli` shall accept steps of the form `run` (string or array of
   strings) with optional `stdin` (string), `env` (string-to-string map), `timeout`
   (milliseconds), and `expect_exit` (integer) modifiers.
3. A web verb in a CLI flow, or a CLI verb in a web flow, shall be a parse error
   reported before any flow executes, with exit code 2.
4. The runner shall execute `run` steps by direct process spawn — no shell — capturing
   stdout, stderr, and exit code; string-form commands shall be whitespace-split into
   argv.
5. Each CLI flow shall execute in a freshly created temporary working directory,
   removed when the flow passes and kept when it fails (NFR-3); a config-level `cwd`
   shall override it.
6. `env` entries shall overlay the inherited environment for that step; `stdin` shall
   be written to the child and closed; `timeout` expiry shall kill the process and fail
   the step as a timeout, defaulting to the config `timeout`.
7. A spawn failure (e.g. command not found) shall fail the step with the underlying
   error. A non-final `run` step shall fail the flow at that step when its exit code
   differs from its expected exit code (`expect_exit`, default 0), reporting that
   step's stderr; the final step's exit code shall never fail the flow by itself.
8. CLI flows shall support the assertions `exit_code`, `stdout_contains`,
   `stdout_matches` (regex), `stderr_contains`, `stderr_matches` (regex),
   `file_exists`, `file_contains: {path, text}`, and `json_output: {path, equals}`.
9. `exit_code`, `stdout_*`, `stderr_*`, and `json_output` shall evaluate once, against
   the last `run` step's captured output, with no retry.
10. `file_exists` and `file_contains` shall retry within the timeout window using the
    PRD-0004 model; relative paths shall resolve against the flow's working directory.
11. A failed CLI assertion shall be reported with the assertion, the exit code, a
    bounded excerpt of captured stdout/stderr, and — when the flow ran in a temporary
    working directory — the path to the kept directory.
12. A CLI flow may declare flow-level `setup` composed of CLI steps, executed in the
    flow's working directory before its steps, with setup-phase error labeling per
    PRD-0006; config-level setup shall not apply to CLI flows.
13. A run containing only CLI flows shall complete on a machine without agent-browser
    installed, and shall not attempt to resolve or launch it.
14. A flow file with no `surface` field shall parse, execute, and report exactly as
    today; the existing test suite shall pass without modification.
15. `formatSummary` shall report mixed-surface runs in one unified summary.
16. This repo shall ship a spec under `specs/` covering `flowspec init` (scaffolds
    config, sample spec, and protection hook), running in CI.
17. README and `docs/specification.md` shall document the `surface` field, the CLI
    grammar, the no-shell rule and its array-form escape hatch, and the fresh-cwd
    execution model.

### Non-Functional Requirements

1. Captured stdout/stderr shall be bounded at 5 MB per stream per step by default,
   overridable via an optional `captureLimit` (bytes) in `flowspec.config.yaml`;
   output beyond the cap is truncated with an explicit truncation marker, not
   silently dropped.
2. The web execution path shall be byte-for-byte behaviorally unchanged — dispatch
   happens before any browser concern, and no web-flow run incurs CLI-adapter work.
3. Temporary working directories shall be removed when the flow passes and kept when
   it fails, with the kept path named in the failure report; a config-level `cwd`
   override is never deleted in either case.
4. An invalid regex in `stdout_matches`/`stderr_matches` shall be a parse-time error,
   not a runtime one.

## 8. Edge Cases & Error States

- **Command not found:** step fails with the spawn error, naming the command. Distinct
  from a nonzero exit, which is assertion territory on the final step.
- **Non-final step exits nonzero without `expect_exit`:** flow fails at that step with
  its stderr; later steps do not run. With `expect_exit: 1` and an actual exit of 1,
  the chain continues; any other exit fails the step.
- **Process exceeds `timeout`:** killed; step fails as a timeout; assertions do not run.
- **Spec asserts `exit_code: 1`:** passes when the command exits 1 — error-path specs
  are first-class.
- **`json_output` on non-JSON stdout:** assertion failure with a parse message and the
  head of the output.
- **`file_contains` on a file that never appears:** retries within the timeout, then
  fails naming the resolved path — mirroring web `wait_for` failure shape.
- **String-form `run` with a quoted argument** (`run: 'echo "two words"'`): the quotes
  are not shell-parsed; the documented answer is the array form.
- **`stdin` provided to a program that never reads it:** harmless; the stream closes.
- **A CLI flow in a run whose config declares web `setup`:** the CLI flow skips it; if
  that shared setup fails, PRD-0006 abort semantics apply to the run unchanged.
- **`surface: cli` under an old flowspec binary:** unknown key dropped, flow misread as
  web. Docs note the minimum version; no runtime mitigation is possible from the old
  binary's side.
- **Unknown surface value (`surface: api`):** parse error, exit 2 — the enum is closed
  until #8 opens it.
- **Huge stdout (a build log):** captured up to the cap (5 MB per stream by default,
  `captureLimit` in config to raise it), truncated with a marker; assertions evaluate
  against the captured portion, so the marker is the tell when a needle "missing" from
  output was actually printed past the cap.

## 9. Dependencies

- Builds on the no-shell argv-spawning pattern `execCommand` (`src/runner.ts:112`)
  established, via a sibling primitive `spawnProcess` (`src/exec.ts`), plus PRD-0004
  assertion retry and PRD-0006's setup phases and skip accounting.
- Touches `src/types.ts`, `src/parser.ts`, `src/runner.ts`, `src/reporter.ts`,
  `src/config.ts` (`cwd`), and docs. No new packages anticipated.
- Downstream: the Conduit adapter (#7) consumes the surface dispatch and the
  file/JSON assertion machinery; the API adapter (#8) consumes the path-based JSON
  comparison. Neither blocks this PRD; both are shaped by it.

## 10. Risks & Open Questions

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Surface dispatch destabilizes the web path | Low | High — every existing consumer | FR-14: existing suite passes unmodified; dispatch precedes all browser code |
| No-shell rule surprises users expecting pipes | Medium | Low — confusing first-run | Documented prominently with the wrap-it-in-a-script recipe |
| Whitespace-split string form mis-parses a command | Medium | Low | Array form documented as the exact escape hatch |
| Assertion machinery built CLI-shaped, hurting #7/#8 reuse | Medium | Medium | Design constraint: primitives land surface-agnostic |

### Open Questions

None remaining — all four resolved 2026-08-16; outcomes recorded in Decisions.

## Decisions

- `surface` is optional and defaults to `web` — zero existing specs change meaning.
- No shell, ever. String form is whitespace-split sugar; array form is the exact path.
  Pipelines belong in scripts the spec runs.
- Non-final steps fail fast on unexpected exit codes, with `expect_exit` as the
  per-step escape hatch; the final step's exit code is pure assertion territory, so
  error paths stay contracts too. *(Resolved from Open Questions, 2026-08-16.)*
- Assertions target the last `run` step; intermediate output is unaddressable in v1.
  Fail-fast polices intermediate steps, side effects are checkable via file
  assertions, and cross-step addressability waits for #8's `capture` design.
  *(Resolved from Open Questions, 2026-08-16.)*
- Final vs. retryable assertions split by what retrying could change: process output is
  final, filesystem state retries within the timeout.
- Fresh tmp cwd per flow: deleted on pass, kept and named in the report on failure —
  the CLI analog of the failure screenshot. `cwd` override lives in mutable config,
  never in specs, and is never deleted. *(Resolved from Open Questions, 2026-08-16.)*
- Config-level setup stays web-only; CLI flows get flow-level setup in CLI grammar.
- Capture cap: 5 MB per stream per step, `captureLimit` config override, explicit
  truncation marker. *(Resolved from Open Questions, 2026-08-16.)*
- The dogfood spec for `flowspec init` ships in this PRD, not a follow-up — the adapter
  is not done until FlowSpec specs itself.
