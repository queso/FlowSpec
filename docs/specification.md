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

surface: "web" | "cli" | "api"  # Optional, default "web". Selects the grammar
                                 # for setup/steps/expect below — see "Surface:
                                 # web or cli" for the CLI grammar and its
                                 # required minimum FlowSpec version, and
                                 # "Surface: api" for HTTP request flows.

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

### Surface: api

`surface: api` is the grammar for REST and webhook services. Steps send HTTP requests, each step checks its own response, and values captured from one response can be used by later steps. No browser and no subprocess is involved.

```yaml
name: label-buy-is-idempotent
description: A replayed buy returns the first result without calling the platform again
surface: api
steps:
  - request:
      post: /tiktok/arcane/labels
      headers:
        Authorization: "Bearer {env.PORTER_BUY_KEY}"
        Idempotency-Key: e2e-buy-1
      json: {orderIds: ["576001"], weight: {value: "1.2", unit: "LB"}}
    capture: {package_id: "$.packageId"}
    expect:
      - status: 200
  - request:
      post: /tiktok/arcane/labels
      headers:
        Authorization: "Bearer {env.PORTER_BUY_KEY}"
        Idempotency-Key: e2e-buy-1
      json: {orderIds: ["576001"], weight: {value: "1.2", unit: "LB"}}
    expect:
      - status: 200
      - json: {path: "$.packageId", equals: "{package_id}"}
  - request:
      get: "{env.PLATFORM_FAKE_URL}/__calls"
      query: {path: /fulfillment/202309/packages, orderId: "576001"}
    timeout: 0
expect:
  - json: {path: "$.count", equals: 1}
```

The last step counts only the platform calls for this flow's own order, so calls made by other flows do not change the result (see [Execution order](#execution-order)). It has `timeout: 0` because the count must not change after the replay: a count of 2 fails at once instead of being polled for the whole retry budget.

#### Steps

| Key | Meaning |
|---|---|
| `request` | Exactly one method key (`get`, `head`, `post`, `put`, `patch`, `delete`) whose value is a path or absolute URL. Optional `headers` (map), `query` (map), and one of `json` (any YAML value, sent as JSON with `Content-Type: application/json` unless the step sets its own `Content-Type`) or `body` (string). GET and HEAD requests cannot have `json` or `body`. |
| `capture` | Map of variable name to JSONPath, read from this step's response body. `{path: "$.token", secret: true}` marks the value as a secret (see Redaction). |
| `expect` | Assertions on this step's response. |
| `timeout` | Retry budget in milliseconds for this step, overriding `--timeout`. `0` means send once and check once. Only valid on GET and HEAD steps; on any other method it is a parse error, since those steps are never retried. |
| `wait` | A step of its own: `wait: <ms>`. Sleeps and sends nothing. |

A step is either a `request` (with optional `capture`, `expect` and `timeout`) or a `wait`. There is no `setup` block on an api flow; a setup request is the flow's first step. Config-level `setup` is web-only and is not applied.

A flow-level `expect` is shorthand for assertions on the last step: it is appended to that step's own `expect` and follows the same retry rules. The last step must then be a `request`. An api flow must have at least one assertion, on a step or at flow level.

Steps of the web or CLI grammar (`visit`, `run`, ...) inside an api flow, and their assertions (`visible`, `exit_code`, ...), are parse errors naming the verb and the surface (exit code 2).

#### Assertions

| Assertion | Passes when |
|---|---|
| `status: <code>` | The response status equals the code. |
| `json: {path, equals}` | The value at `path` equals `equals` (see Comparison). |
| `json: {path, in: [...]}` | The value at `path` equals one member of the list. |
| `json: {path, matches: <regex>}` | The value at `path` is a string and matches the regex. |
| `json: {path, exists: true\|false}` | `path` resolves (or does not). |
| `header: {name, equals\|contains}` | The response header (name matched case-insensitively) equals or contains the string. |
| `latency_under: <ms>` | The checked response arrived, body included, within `<ms>` of the request being sent. |

`path` uses the same dot-path form as the CLI surface's `json_output`: `$.a.b`, with array elements addressed by index (`$.items.0.id`). Bracket syntax (`$.items[0]`) and filters are not supported.

A `json` assertion against a body that is not valid JSON fails and reports the first 500 bytes of the body. A failing `status` assertion also reports the first 500 bytes.

Redirects are not followed: a `302` is reported as a `302`, so a flow can assert on it.

#### Comparison

`equals` and `in` use strict deep equality, the same comparison as the CLI surface's `json_output`. Types must match: `"1.25"` does not equal `1.25`, and `"1"` does not equal `1`. There is no loose mode. A flow that accepts either form lists both: `in: [1.25, "1.25"]`. Failure messages print both values as JSON and name their types when the types differ, for example `expected "1.25" (string) but got 1.25 (number)`.

#### Variables

- `{name}` reads a variable captured by an earlier step. Names match `[A-Za-z_][A-Za-z0-9_]*`.
- `{env.NAME}` reads `process.env.NAME`.
- `{{` produces a literal `{` and `}}` produces a literal `}`.
- Any other text in braces is literal: `{"a": 1}` in a `body` string is sent as written.

Because `}}` always produces `}`, a `body` string containing nested JSON that ends in `}}` must write `}}}}`. Use `json:` for structured bodies instead.

Templates apply to the request path or URL, `query` values, `headers` values, `body`, and string values anywhere inside `json` (object keys are not templated). In assertions they apply to `json.equals`, members of `json.in`, `header.equals` and `header.contains`. They do not apply to `json.matches` (a substituted value would be read as regex syntax), JSONPath expressions, or header names.

A string that is exactly one reference, such as `"{package_id}"`, is replaced by the variable's value with its type kept: a captured number stays a number in a JSON body and in `equals`. A reference inside a longer string, such as `"Bearer {env.KEY}"` or `"/orders/{id}"`, is converted to a string; embedding an object, array or null value fails the step. `env` values are always strings.

- An unset `{env.NAME}` is a load-time error. `flowspec run` checks every api flow before any flow runs and exits 2, naming the variable and where it is used, so a missing key fails the run before anything is bought.
- A `{name}` that no earlier step has captured fails the step that uses it, naming the variable. The step's request is not sent.
- A `capture` whose JSONPath does not resolve fails its step, naming the variable and the path. The next step does not run.

Flow variables are separate from the `${VAR}` syntax in `flowspec.config.yaml`. Config interpolation runs once when the config file loads; flow variables resolve as each step runs and include captures.

#### Retries

The retry budget is the step's `timeout` if it has one, otherwise `--timeout` (config `timeout`). Polling uses the same interval as web assertions.

- **GET and HEAD:** if any of the step's assertions fails, the request is sent again and all of the step's assertions are checked against the new response, until they all pass or the budget expires. This includes `status`, so a job that answers 202 and later 200 can be polled. `capture` reads from the response that passed. A connection error counts as a failed attempt.
- **POST, PUT, PATCH, DELETE:** the request is sent once and every assertion is checked once against that response. FlowSpec never re-sends one of these on its own.
- **`timeout: 0` on a GET:** the first response is the only one checked. Use it for checks that must be true immediately, such as a label existing right after the buy.
- `latency_under` is checked against the response it is evaluated on. A slow first response that is retried and comes back fast passes. Use `timeout: 0` when the first response must be fast.

```yaml
  - request: {get: "/shopify/arcane/labels/{label_id}"}   # polled until PURCHASED
    expect:
      - status: 200
      - json: {path: "$.status", equals: "PURCHASED"}
  - request: {get: "/tiktok/arcane/labels/{package_id}"}   # must exist right now
    timeout: 0
    expect:
      - status: 200
```

A single request may take up to `stepTimeout` (`--step-timeout`, default 60000 ms) to answer before it fails.

#### Base URL, headers and auth

- Relative paths resolve against `baseUrl` (config or `--base-url`).
- Absolute URLs are allowed and can come from env, for example `"{env.PLATFORM_FAKE_URL}/__calls"`.
- Config-level `headers` apply under the same `headersScope` rules as the web surface: `origin` (the default) sends them only to requests to `baseUrl`'s origin, `all` sends them to every request. A step's own `headers` replace config headers with the same name (compared case-insensitively).
- Auth is a header built from env, such as `Authorization: "Bearer {env.PORTER_BUY_KEY}"`. Several keys with different scopes are several env variables.

#### Redaction

- Every value read through `{env.NAME}` is a secret for the whole run, including in flows that do not reference it, unless its name is listed in the config's `publicEnv`.
- `publicEnv` (in `flowspec.config.yaml`) lists env names that are not secrets, such as a service URL or a run id used in order ids and idempotency keys. They are read the same way, but their values are never redacted and get no short-value warning, so failure messages that contain them stay readable. Every env name not on the list stays secret. An unset public name still fails the run at load time.

  ```yaml
  publicEnv: [PLATFORM_FAKE_URL, RUN_ID]
  ```

- A capture marked `secret: true` is a secret from the moment it is captured.
- Every occurrence of a secret in run output is replaced with `[REDACTED:NAME]` (the env variable name or the capture name). This covers failure messages, including expected values that came from a secret, and the request and response recorded for a failing step. The JSON-escaped and URL-encoded forms of a secret are replaced too.
- Secret values shorter than 8 characters are not redacted, since replacing a short substring everywhere would mangle unrelated output. FlowSpec prints a warning naming the variable to stderr instead. A value that is not meant to be secret belongs in `publicEnv`, which also silences the warning.
- Config-level header values are recorded as `[config header]`, not their value.

#### Failure report

A failing api step reports the step, the assertion that failed, the request that was sent (method, URL, headers, body), and the response it was checked against (status, latency, headers, body). Bodies are cut to 500 bytes. A GET that was retried says how many requests were sent:

```
✗ shopify-label-is-polled-until-purchased (10.3s)
  Step 1: GET /shopify/arcane/labels/{label_id}
  Error: json $.status expected "PURCHASED" but got "PENDING" (after 41 requests over 10004ms)
  Request: GET http://localhost:3000/shopify/arcane/labels/lbl_1
    authorization: Bearer [REDACTED:PORTER_BUY_KEY]
  Response: 202 in 3ms
    content-type: application/json; charset=utf-8
  Response body: {"labelId":"lbl_1","status":"PENDING"}
```

#### Execution order

Flows run one at a time, never in parallel. A directory's files run in sorted path order; files named on the command line run in the order given (`flowspec run b.flow.yaml a.flow.yaml` runs `b` first). Steps within a flow also run one at a time, in order.

FlowSpec does not reset state the system under test keeps between flows, such as a fake platform's call counts. A flow that asserts on a shared counter should reset it in its first step (`post: "{env.PLATFORM_FAKE_URL}/__reset"`) or query only calls tagged with a value unique to that flow, such as its own order id or idempotency key. A run id from the environment (`"576001-{env.RUN_ID}"`, with `RUN_ID` in `publicEnv`) makes those values unique per run as well.

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
timeout: number                 # Assertion retry timeout, in milliseconds. Never a
                                 # process deadline — see `stepTimeout`.
stepTimeout: number             # Optional, CLI-surface only. Milliseconds a single
                                 # `run` step's process may live before it is killed.
                                 # Positive integer; defaults to 60000.
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
                                 # for surface: cli flows — see below. Must be
                                 # non-empty when present.

captureLimit: number            # Optional, CLI-surface only. Bytes per captured
                                 # stdout/stderr stream — see below.

publicEnv: [string]             # Optional, api-surface only. Env names read by
                                 # {env.NAME} that are not secrets: not redacted,
                                 # no short-value warning. See "Redaction" under
                                 # "Surface: api".
```

`headers` is config-level for web and CLI flows: there is no flow-level `headers` block.
Header auth describes the environment a flow runs against, not the behavior the flow
asserts, so it stays out of the immutable `specs/**` surface (see `adr/0003`). An api
flow's request steps may set their own `headers` (see [Surface: api](#surface-api)),
and keep credentials out of the spec by reading them from `{env.NAME}`; config headers
still apply to api requests under `headersScope`. The repeatable
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

`cwd`, `stepTimeout` and `captureLimit` configure `surface: cli` flows only; web flows ignore all three. `stepTimeout` has the `--step-timeout <ms>` flag; `cwd` and `captureLimit` have no `--flag` equivalent.

`cwd` is the working directory every CLI flow's commands run in — a relative value resolves against the directory FlowSpec was invoked from. Leave it unset and each CLI flow gets its own fresh, isolated temporary directory instead (deleted on pass, kept on fail — see "Working directory" under [Surface: web or cli](#surface-web-or-cli)). An empty (or whitespace-only) `cwd` is a validation error rather than a silent fallback: it would otherwise resolve to the directory FlowSpec was invoked from — the real project tree — turning an isolated, disposable workspace into the working copy, uncleaned.

`stepTimeout` is the process-kill deadline for one `run` step, and is deliberately a separate key from `timeout`: an assertion retry budget and a process deadline answer different questions, and using one value for both meant a ten-second retry window silently killed any command that legitimately ran longer (an install, a build, a network fetch). A step's own `timeout` overrides it. `--step-timeout` rejects `0`, negatives and non-integers with exit code 2, since those reach the spawn primitive as a real, immediate kill deadline rather than as "no limit".

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

### API Mode: HTTP Requests

A `surface: api` flow (see [Surface: api](#surface-api)) is also dispatched before any browser logic runs and never resolves `agent-browser`. Its requests are sent with `fetch`, one step at a time.

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
- **Parallel execution**: Run independent flows concurrently. Flows run one at a time today; if this is added, it will be opt-in and off by default, since api flows can share state in the system under test
- **Tags/filtering**: Run subsets of flows by tag
