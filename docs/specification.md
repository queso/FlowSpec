# FlowSpec Specification

## Motivation

In the age of agentic coding, AI agents have write access to entire codebases, including tests. This creates a fundamental problem: when a test fails, the agent may "fix" the test rather than fix the underlying bug. Tests are supposed to be the oracle that defines correct behavior, but if the oracle can be modified by the same entity writing the code, the safety net disappears.

FlowSpec addresses this by establishing a clear separation:

1. **Specification tests** (user flows, acceptance criteria): Immutable to agents. These encode *what* the product should do from a user's perspective.
2. **Implementation tests** (unit tests, integration tests): Agent-modifiable. These encode *how* the code works and naturally evolve with refactoring.

## Design Principles

### Human-Readable Selectors

Inspired by React Testing Library, FlowSpec forces the use of human-readable labels rather than CSS selectors or test IDs. Specs reference elements the way users would:

```yaml
- click: "Place Order"           # Not: click: "#submit-btn"
- fill:
    "Email": "user@test.com"     # Not: fill: { selector: "input[name=email]" }
```

This approach:
- Makes specs self-documenting
- Ensures accessibility (proper labels, roles, semantic HTML)
- Creates self-enforcing contracts (if the button doesn't say "Place Order", the test fails)
- Eliminates selector maintenance burden

### Immutability via Hooks

Claude Code hooks block agent modifications to spec files:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node -e \"const j=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));if(/\\bspecs\\/.*\\.flow\\.yaml$/.test(j.tool_input?.file_path||'')){console.log(JSON.stringify({decision:'block',reason:'Flow specs are immutable. Fix the implementation, not the spec.'}))}\""
          }
        ]
      }
    ]
  }
}
```

When a spec fails, the agent receives clear feedback: modify the implementation, not the specification.

### Context-Rich Specifications

Each flow includes a `description` field that explains the business intent—the *why* behind the test:

```yaml
name: checkout-flow
description: |
  The user ends up on this page during the checkout process.
  They likely have items in their cart. We want to capture
  their information so we can store it for later but also
  use it for shipping and billing.

  A successful checkout should:
  - Validate shipping details
  - Process payment
  - Create an order record
  - Show confirmation with order number
```

This context helps agents understand what business goal they're preserving when fixing failures, rather than just mechanically satisfying assertions.

## Spec Format

### Schema

```yaml
name: string                    # Identifier for the flow
description: string             # Business context and intent

surface: "web" | "cli"          # Optional, default "web". Selects the grammar
                                 # for setup/steps/expect below — see "Surface:
                                 # web or cli" for the CLI grammar and its
                                 # required minimum FlowSpec version.

setup:                          # Optional: steps to run once, in the same
                                 # browser session, before `steps` (e.g.
                                 # planting an auth session). Same grammar as
                                 # `steps`. A flow-level `setup` replaces any
                                 # config-level `setup` entirely; `setup: []`
                                 # opts the flow out of setup altogether.
  - visit: "/setup-path"        # Relative paths resolve against baseUrl's
                                 # origin and path only — see the note below.

steps:                          # Ordered user actions
  - visit: "/path"              # Navigate to URL
  - click: "Button Text"        # Click element by visible text
  - fill:                       # Fill form fields by label
      "Label": "value"
  - select:                     # Select dropdown option by label
      "Label": "option"
  - wait_for: "Text"            # Wait for text to appear (with retry)

expect:                         # Assertions after steps complete
  - url: "/expected/path"       # Current URL matches
  - visible: "Expected text"    # Text is visible on page
  - matches: "regex pattern"    # Text matching pattern is visible
  - not_visible: "Text"         # Text is not visible
```

A relative `visit:` path is resolved against `baseUrl`'s origin and path only — a
query string on `baseUrl` is **not** carried over. A setup step that must land on a
URL carrying a token query param (`https://preview.example.dev?_ab=TOKEN`) has to
spell that URL out absolutely; writing `visit: "/"` against that `baseUrl` navigates
to `https://preview.example.dev/` with the token stripped, and whatever session the
token would have planted is never established.

### Surface: web or cli

`surface` is the discriminator between the two grammars a flow can be written in. It is optional, and its absence means exactly the same thing as `surface: web` — the schema above, unchanged. `surface: cli` switches `setup`, `steps`, and `expect` to a different, command-line-oriented grammar entirely; the two never mix within one flow (a web verb in a CLI flow, or a `run` step in a web flow, is a schema validation error naming the offending verb and the flow's surface).

**Minimum version: flowspec v0.2.0.** `surface` did not exist before this version. Because FlowSpec's top-level schema does not reject unrecognized keys, an older binary parsing a `surface: cli` flow silently drops the `surface` key and then validates `steps`/`expect` against the web-only grammar it knows, which a `run` step or a CLI assertion cannot satisfy — the practical result is a confusing parse failure, not a silent misinterpretation as a passing web flow. Projects adopting `surface: cli` should pin a minimum FlowSpec version.

```yaml
name: build-succeeds
description: The production build completes and writes the expected bundle
surface: cli

setup:                          # Optional: same CLI step grammar as `steps`,
                                 # run first, in the same working directory.
                                 # Every setup step's exit code is fatal on
                                 # mismatch (no "final step" leniency — see
                                 # "Exit codes within a CLI flow" below).
  - run: ["node", "scripts/seed-fixture.js"]

steps:                          # CLI run steps, executed in order
  - run: "npm run build"        # string form: whitespace-split, no shell
  - run: ["node", "-e", "console.log('done')"]  # array form: passed through untouched
    stdin: "y\n"                # optional: written to the command, then closed
    env:                        # optional: overlaid on the inherited env for
      NO_COLOR: "1"             # this step only, never leaked to siblings
    timeout: 5000                # optional: ms before the command is killed
    expect_exit: 0               # optional: see "Exit codes within a CLI flow"

expect:                         # The eight CLI assertions, checked against
  - exit_code: 0                # the LAST step's captured result
  - stdout_contains: "done"
  - stdout_matches: "^done$"
  - stderr_contains: "warning"
  - stderr_matches: "^warning:"
  - file_exists: "dist/bundle.js"                       # path resolved against the
  - file_contains: { path: "dist/bundle.js", text: "//# sourceMappingURL" }  # working directory
  - json_output: { path: "$.status", equals: "ok" }      # dot-path into stdout, parsed as JSON
```

**No shell, ever.** CLI steps never invoke a shell. String-form `run` is split on whitespace only (no quote handling, no metacharacter interpretation): `run: "echo a && echo b"` runs the single command `echo` with four literal arguments `a`, `&&`, `echo`, `b` — nothing is chained, and a quoted substring is not reassembled into one argument. Two escape hatches cover what a shell would otherwise provide: the **array form** for an argument containing spaces or quotes (`run: ["node", "-e", "an arg with spaces"]`), and invoking a shell explicitly (or a script file) for pipes, redirects, globbing, or `&&` chaining (`run: ["bash", "-c", "cat *.log | grep ERROR"]`).

**Retry split.** `exit_code`, `stdout_contains`/`stdout_matches`, `stderr_contains`/`stderr_matches`, and `json_output` are checked exactly once against the last step's already-captured output — that output cannot change, so there is nothing to retry. `file_exists` and `file_contains` poll within the flow's timeout instead, because the file they check for may still be written by something asynchronous after the triggering command has already returned — the same rationale as the web surface's `wait_for` and assertion retries.

**Exit codes within a CLI flow.** This is the least guessable rule in the grammar: `expect_exit` is honored on every step, including the last one, but only the **absence** of `expect_exit` on the final step makes its exit code non-fatal.

- A **non-final** step's exit code must equal its `expect_exit` (default `0`) or the flow fails immediately at that step, and no later step runs — fail-fast, because a setup or build step that didn't succeed makes everything after it meaningless.
- The **final** step is different, deliberately: if it declares `expect_exit`, that's checked exactly like any other step; if it does **not**, its exit code is never fatal by itself, and the flow proceeds to `expect` regardless of what the command returned. This is what makes "this command should fail" a first-class, error-path spec rather than something the runner treats as broken.
- **Setup steps** always use the non-final rule, including the last step in `setup` — setup has no assertion phase of its own for a bare exit code to defer to.

**Working directory.** Every CLI flow's `setup` and `steps` run inside one shared working directory. With no `cwd` configured (see [Configuration File](#configuration-file)), FlowSpec creates a fresh, empty temporary directory per flow (prefixed `flowspec-`), deletes it when the flow passes, and keeps it — printing its absolute path in the failure report, the CLI analog of the web surface's failure screenshot — when the flow fails. A configured `cwd` is used as-is and is never created or deleted by FlowSpec, on pass or fail.

### Full Example

```yaml
name: user-registration
description: |
  New users can create an account with email and password.
  After registration, they should be logged in and see their dashboard.
  This is the primary acquisition funnel entry point.

steps:
  - visit: "/signup"
  - fill:
      "Email": "newuser@example.com"
      "Password": "SecurePass123!"
      "Confirm Password": "SecurePass123!"
  - click: "Create Account"

expect:
  - url: "/dashboard"
  - visible: "Welcome, newuser@example.com"
  - visible: "Complete your profile"
```

## Configuration File

Project-level settings live in `flowspec.config.yaml`, discovered by walking up from
the current directory. CLI options override file values.

```yaml
baseUrl: string                 # Origin every relative `visit:` resolves against
timeout: number                 # Assertion retry timeout (web), in milliseconds.
                                 # Also the CLI kill-deadline fallback — see
                                 # "CLI-surface settings" below.
specsDir: string                # Directory flows are loaded from

setup:                          # Optional: steps run once per flow, in that flow's
                                 # own browser session, before its `steps`. Shared by
                                 # every flow; a flow-level `setup` replaces it, and
                                 # `setup: []` on a flow opts out. Same grammar as a
                                 # flow's `steps`. WEB-ONLY — never applied to a
                                 # `surface: cli` flow (see below).
  - visit: "https://preview.example.dev?_ab=${PREVIEW_TOKEN}"

headers:                        # Optional: HTTP headers applied to each flow's
                                 # browser session before `setup` and `steps` run, so
                                 # every request to `baseUrl`'s origin carries them.
                                 # For deployments gated on a request header rather
                                 # than a URL or login form.
  x-vercel-protection-bypass: "${BYPASS_TOKEN}"

headersScope: "origin" | "all"  # Optional: how far `headers` travel. Default
                                 # "origin" — only requests to `baseUrl`'s origin
                                 # carry them. "all" sends them context-wide, on
                                 # every request to every origin.

cwd: string                     # Optional, CLI-surface only. Working directory
                                 # for surface: cli flows — see below.

captureLimit: number            # Optional, CLI-surface only. Bytes per captured
                                 # stdout/stderr stream — see below.
```

`headers` is config-level only — there is no `headers` block in a flow file. Header
auth describes the environment a flow runs against, not the behavior the flow asserts,
so it stays out of the immutable `specs/**` surface (see `adr/0003`). The repeatable
CLI flag `--header "Name: value"` replaces the `headers` block outright rather than
merging into it; `headersScope` has no CLI equivalent.

Headers are origin-scoped by default: they attach to requests to `baseUrl`'s origin —
same-origin subresources included — and to nothing else, so a bypass token is never
sent to a CDN, an analytics pixel, or an absolute `visit:` to another origin. Matching
is by host and ignores scheme. `headersScope: all` is the opt-out, restoring
context-wide headers for flows that legitimately span origins.

Header names and values are validated before any browser command runs: a name that is
not a valid HTTP token, or a value containing NUL, carriage return, or line feed, fails
with the `Failed to apply headers: ...` error below, naming the offending header.

String values in this file support `${VAR_NAME}` references, resolved from
`process.env` at load time; a referenced variable that isn't set is a hard error naming
the variable and the config file path, raised before any flow is parsed or any browser
session opens. Only *values* are interpolated — keys are never touched, so a header
name containing `${...}` is left as written. Interpolation never runs on flow spec
files under `specs/`, nor on CLI arguments — a `--header` value is sent as the shell
delivered it.

A failure applying `headers` aborts the run, since the headers are shared by every
flow: the flow being run is reported as failed with a `Failed to apply headers: ...`
error and every remaining flow is reported as skipped — the same contract as a
config-level `setup` failure.

### CLI-Surface Settings

`cwd` and `captureLimit` configure `surface: cli` flows only; web flows ignore both, and neither has a `--flag` equivalent.

`cwd` is the working directory every CLI flow's commands run in — a relative value resolves against the directory FlowSpec was invoked from. Leave it unset and each CLI flow gets its own fresh, isolated temporary directory instead (deleted on pass, kept on fail — see "Working directory" under [Surface: web or cli](#surface-web-or-cli)).

`captureLimit` bounds how much of a CLI step's stdout and stderr FlowSpec captures, in bytes, each stream independent of the other; output beyond it is truncated with a `[truncated]` marker. There is **no config-level default** for `captureLimit` — leaving it unset does not write a value into the loaded config. The 5 MB (`5 * 1024 * 1024` byte) default is applied downstream, at the point a CLI step actually executes, not at config-load time; this config key only overrides that downstream default when present.

Config-level `setup` (documented above) uses the web step grammar and is never applied to a `surface: cli` flow — a `run` step inside config-level `setup` is a validation error. A CLI flow that needs setup work declares its own flow-level `setup` block instead, in the CLI step grammar (see [Surface: web or cli](#surface-web-or-cli)).

## Execution Modes

### CI Mode: Deterministic Runner

For continuous integration, FlowSpec provides a deterministic runner that executes specs without an LLM. This is fast, cheap, and repeatable. The runner uses [agent-browser](https://github.com/vercel-labs/agent-browser) for browser automation.

```typescript
// Simplified runner logic using agent-browser CLI
import { execSync } from 'child_process';

function ab(command: string): string {
  return execSync(`agent-browser ${command}`, { encoding: 'utf-8' });
}

async function runFlow(flow: Flow) {
  for (const step of flow.steps) {
    if (step.visit) {
      ab(`open ${step.visit}`);
    } else if (step.click) {
      const snapshot = ab('snapshot -i');
      const ref = findRefByText(snapshot, step.click);
      ab(`click ${ref}`);
    } else if (step.fill) {
      for (const [label, value] of Object.entries(step.fill)) {
        const snapshot = ab('snapshot -i');
        const ref = findRefByLabel(snapshot, label);
        ab(`fill ${ref} "${value}"`);
      }
    } else if (step.select) {
      for (const [label, value] of Object.entries(step.select)) {
        const snapshot = ab('snapshot -i');
        const ref = findRefByLabel(snapshot, label);
        ab(`select ${ref} "${value}"`);
      }
    } else if (step.wait_for) {
      // Polls until text appears or timeout
      await waitForText(step.wait_for, timeout);
    }
  }

  for (const assertion of flow.expect) {
    const snapshot = ab('snapshot');
    if (assertion.visible) {
      assertTextVisible(snapshot, assertion.visible);
    } else if (assertion.url) {
      assertUrlMatches(assertion.url);
    } else if (assertion.matches) {
      assertTextMatches(snapshot, new RegExp(assertion.matches));
    }
  }
}
```

Usage:

```bash
bunx flowspec run specs/                     # Run all flows
bunx flowspec run specs/checkout.flow.yaml   # Run single flow
```

### CLI Mode: No Browser at All

A `surface: cli` flow (see [Surface: web or cli](#surface-web-or-cli)) is dispatched before any of the logic above runs — before a browser session name is even generated, before `headers` are validated. `flowspec run` decides which surface a flow uses purely by reading its `surface` field, and a CLI flow never resolves or launches `agent-browser`. This is what makes a CLI-only project work on a machine that doesn't have `agent-browser` installed at all: the dependency noted in [Installation](../README.md#installation) is required only if at least one flow actually uses the web surface.

Simplified CLI runner logic:

```typescript
import { spawn } from 'node:child_process'; // FlowSpec spawns directly — no shell

async function runCliFlow(flow: Flow) {
  const workdir = createWorkingDirectory(flow); // fresh temp dir, or the configured cwd

  let lastResult;
  for (const [index, step] of flow.steps.entries()) {
    const argv = Array.isArray(step.run) ? step.run : step.run.split(/\s+/);
    const result = await spawnAndCapture(argv, { cwd: workdir, ...step });
    lastResult = result;

    const isLast = index === flow.steps.length - 1;
    const expected = step.expect_exit ?? 0;
    const exitCodeIsFatal = !isLast || step.expect_exit !== undefined;
    if (exitCodeIsFatal && result.exitCode !== expected) {
      return fail(workdir, `step ${index} exited ${result.exitCode}, expected ${expected}`);
    }
  }

  for (const assertion of flow.expect) {
    const failure = await evaluateCliAssertion(assertion, lastResult, workdir);
    if (failure) return fail(workdir, failure.message);
  }

  deleteWorkingDirectory(workdir); // only on pass — a fresh temp dir is kept on failure
  return pass();
}
```

Every command is spawned directly from its `run` array (or the whitespace-split string form) — never through a shell, and never through `agent-browser`. See [No shell, ever](#surface-web-or-cli) for what that means for pipes, quoting, and shell metacharacters.

### Development Mode: Agent-Driven Execution

During development, an agent can run flows interactively using the `agent-browser` skill. This enables:

- Interactive debugging when flows fail
- Immediate code fixes based on failure context
- Visual verification of UI state

The agent reads the spec, executes via browser automation, observes failures with full context (including the `description`), and modifies implementation code to fix issues.

## Project Structure

```
your-project/
├── specs/
│   ├── checkout.flow.yaml
│   ├── login.flow.yaml
│   ├── registration.flow.yaml
│   └── ...
├── src/
│   └── ...
├── .claude/
│   └── settings.local.json    # Contains hooks config
└── package.json
```

## Claude Code Integration

### Quick Start with `flowspec init`

The easiest way to set up FlowSpec protection is with the init command:

```bash
flowspec init
```

This creates the necessary hook configuration automatically, along with a sample flow and config file.

### Hook Configuration

Add to `.claude/settings.local.json` (or use `flowspec init`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "node -e \"const j=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));if(/\\bspecs\\/.*\\.flow\\.yaml$/.test(j.tool_input?.file_path||'')){console.log(JSON.stringify({decision:'block',reason:'Flow specs are immutable. Fix the implementation, not the spec.'}))}\""
          }
        ]
      }
    ]
  }
}
```

If you already have a `settings.local.json`, running `flowspec init` again will merge the hook into your existing configuration without overwriting other settings.

### Skill for Agent Execution

A FlowSpec skill can be installed to allow agents to run flows interactively:

```
User: "Run the checkout flow and fix any failures"
Agent: [reads specs/checkout.flow.yaml]
Agent: [executes via agent-browser]
Agent: "Step 'click: Place Order' failed - button shows 'Submit Order' instead"
Agent: [modifies implementation to change button text]
Agent: [re-runs flow, passes]
```

## Relationship to PRDs and User Stories

FlowSpec bridges the gap between product requirements and executable tests:

```
PRD / User Story
      ↓
  FlowSpec (immutable contract)
      ↓
  Implementation (agent-modifiable)
```

The `description` field in each flow can directly reference or quote the originating user story, creating traceability from requirement to verification.

## Benefits Summary

| Concern | FlowSpec Approach |
|---------|-------------------|
| Agent modifying tests | Blocked via hooks |
| Selector maintenance | None; uses human-readable labels |
| Accessibility | Enforced by design |
| Business context | Captured in description |
| CI execution | Deterministic, no LLM needed |
| Development debugging | Agent-driven with full context |
| Spec drift | Self-enforcing (labels must match) |

## Future Considerations

- **Fixtures**: Separate (also immutable) files defining test data ("valid shipping address")
- **Flow composition**: Reusable steps across flows (login, add to cart)
- **Screenshots on failure**: Automatic capture for debugging
- **Parallel execution**: Run independent flows concurrently
- **Tags/filtering**: Run subsets of flows by tag
