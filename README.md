# FlowSpec

Immutable user flow specifications for the age of agentic coding.

## The Problem

AI coding agents can modify both implementation and tests. When a test fails, the agent might "fix" the test instead of fixing the bug. This breaks the feedback loop that catches regressions.

## The Solution

FlowSpec separates **what your app should do** (immutable specs) from **how it does it** (agent-modifiable code).

- Write user flows in simple YAML
- Use human-readable labels (accessibility-first, a la React Testing Library)
- Protect specs from agent modification via Claude Code hooks
- Run deterministically in CI or interactively with an agent

## Installation

```bash
# Install globally
npm install -g flowspec

# Or with bun
bun add -g flowspec
```

Requires [agent-browser](https://github.com/anthropics/agent-browser) for browser automation.

## Usage

### Initialize a New Project

```bash
# Scaffold a new FlowSpec project in the current directory
flowspec init

# Initialize in a specific directory (creates it if it doesn't exist)
flowspec init --dir apps/web
flowspec init --dir /absolute/path/to/project
```

This creates:
- `flowspec.config.yaml` - Project configuration
- `specs/example.flow.yaml` - Sample flow to get started
- `.claude/settings.local.json` - PreToolUse hook to protect specs from AI modification
- Updates `package.json` with `test:e2e` script

Running `init` again is safe: existing files are skipped, and the protection hook is merged into an existing `settings.local.json` without overwriting your other settings.

#### Monorepo Setup

FlowSpec detects monorepo markers in the target directory:

| Marker | Detected when |
| ------ | ------------- |
| `pnpm-workspace.yaml` | File exists in directory |
| `turbo.json` | File exists in directory |
| `nx.json` | File exists in directory |
| `workspaces` | Field present in `package.json` |

When markers are found, `init` warns that you may be running from the repo root rather than an app subdirectory. The warning is advisory — init still proceeds and creates all files.

**Recommended approach for monorepos:** run init from your app's subdirectory or use `--dir`:

```bash
# From the repo root, target a specific app
flowspec init --dir apps/web
flowspec init --dir packages/marketing-site

# Or cd into the app first
cd apps/web && flowspec init
```

FlowSpec also searches for existing `flowspec.config.yaml` and `specs/` directories nearby (upward in parent directories and one level down into children) and reports them when found, so you can see if another part of your monorepo is already set up.

### Run Flows

```bash
# Run a single flow file
flowspec run specs/checkout.flow.yaml

# Run all flows in a directory
flowspec run specs/

# Specify a custom base URL
flowspec run specs/ --base-url http://localhost:8080

# Set assertion retry timeout (default: 5000ms)
flowspec run specs/ --timeout 10000

# Disable assertion retries (fail immediately)
flowspec run specs/ --timeout 0

# Give each CLI (surface: cli) run step longer before it is killed
flowspec run specs/ --step-timeout 300000

# Send an extra HTTP header (repeatable)
flowspec run specs/ --header "x-vercel-protection-bypass: $BYPASS_TOKEN"

# Show help
flowspec --help
```

### Configuration File

FlowSpec looks for `flowspec.config.yaml` in the current directory or parent directories:

```yaml
baseUrl: http://localhost:3000
timeout: 10000       # assertion retry budget (web + file assertions)
stepTimeout: 60000   # CLI run-step process deadline (surface: cli only)
specsDir: specs/
```

CLI options override config file values.

`timeout` and `stepTimeout` are two different clocks and are never
interchangeable: `timeout` is how long an assertion keeps being re-checked
before it fails, while `stepTimeout` is how long a single `surface: cli` run
step's process may live before it is killed. `--step-timeout` must be a
positive integer — `0` or a negative value is rejected with exit code 2,
since a zero-millisecond deadline would kill every step the instant it
starts.

#### `cwd` and `captureLimit`: CLI-Surface Settings

Two config keys exist only for `surface: cli` flows (see [CLI Flows](#cli-flows-surface-cli) below) and are ignored by web flows:

```yaml
# flowspec.config.yaml
cwd: ./sandbox        # optional — see "Working Directory" below
captureLimit: 1048576 # optional — bytes per captured stream, default 5 MB (5 * 1024 * 1024)
```

- **`cwd`** — the directory a CLI flow's commands run in. A relative path resolves against the directory FlowSpec itself was invoked from. When absent, each CLI flow gets its own fresh temporary directory instead (see [Working Directory](#working-directory)).
- **`captureLimit`** — the ceiling, in bytes, on how much of a command's stdout and stderr FlowSpec captures (each stream is bounded independently). Output beyond the limit is truncated with a `[truncated]` marker. There is no config-level default — an absent `captureLimit` means each CLI step falls back to the built-in 5 MB default at execution time, not at config-load time.

Neither key has a CLI-flag equivalent, and neither affects web flows at all.

**Config-level `setup` stays web-only.** The `setup` block described in [Setup: Shared Steps Before Every Flow](#setup-shared-steps-before-every-flow) above uses the web step grammar (`visit`, `click`, `fill`, `select`, `wait_for`) and is never applied to a CLI flow — a `run` step in config-level `setup` is a validation error. A CLI flow that needs setup work declares its own flow-level `setup` block, in the CLI step grammar, instead (see [CLI Flows](#cli-flows-surface-cli)).

#### Setup: Shared Steps Before Every Flow

A `setup` block runs once per flow, inside that flow's own browser session, immediately before its `steps`. It's the way to establish state every flow needs — most commonly, authenticating against a password-protected preview deployment.

For example, a Shopify Oxygen-style preview URL that gates access behind a token query param:

```yaml
# flowspec.config.yaml
baseUrl: https://preview-abc123.myshopify.dev?_ab=${PREVIEW_TOKEN}
setup:
  - visit: https://preview-abc123.myshopify.dev?_ab=${PREVIEW_TOKEN}
```

Visiting the token URL plants a session cookie, so every flow that follows runs against an authenticated session without needing its own login steps. Without this, every flow fails with a misleading "could not find element" on what looks like the login page — the real problem is the preview deployment never let the browser past auth in the first place.

**Spell the token URL out in full.** That's why the example above repeats the whole URL in `setup` instead of writing `- visit: /`. A relative `visit:` is resolved against `baseUrl`'s origin and path only — a query string on `baseUrl` is **not** carried over. With `baseUrl: https://preview-abc123.myshopify.dev?_ab=${PREVIEW_TOKEN}`, a setup step of `- visit: /` navigates to `https://preview-abc123.myshopify.dev/` with no `_ab` param, so the auth cookie is never planted and every flow fails the same misleading way. Any setup step that must hit the token URL has to write it out absolutely.

`setup` can also be declared per-flow (see [Flow File Format](#flow-file-format)):

- A flow-level `setup` **replaces** the config-level `setup` entirely — it does not merge with it.
- An explicit `setup: []` on a flow opts that flow out of setup altogether, which is useful for a flow that specifically tests the unauthenticated state. Note that this opt-out does not survive a shared-setup failure: when the config-level `setup` fails the run aborts, and every remaining flow is reported as skipped — including `setup: []` flows and flows carrying their own `setup` block.

**Failure behavior:** if a shared (config-level) `setup` step fails, the run aborts immediately — that flow is reported as failed with a `Setup step N:` error, and every remaining flow is reported as skipped, since a broken shared setup means every subsequent flow would fail the same way. If a flow-level `setup` step fails, only that one flow fails; the run continues normally with the remaining flows.

#### Headers: Header-Based Auth

A `headers` map in `flowspec.config.yaml` applies HTTP headers to each flow's browser session, before that flow's `setup` and `steps` run. It's the way past a deployment that gates access on a request header rather than on a URL or a login form.

For example, a Vercel preview deployment behind Deployment Protection, which lets a request through when it carries a bypass token header:

```yaml
# flowspec.config.yaml
baseUrl: https://myapp-preview.vercel.app
headers:
  x-vercel-protection-bypass: ${BYPASS_TOKEN}
```

Every request the session makes to that deployment carries these headers — setup steps and flow steps alike — so no flow needs its own auth handling. The same shape works for a Netlify preview password header or an `Authorization` header on an API-gated environment.

Header **values** support [`${VAR}` interpolation](#var-interpolation), which is how the token stays out of the committed config file. Header **names** are never interpolated — a `${...}` in a header name is left alone.

**Scope: `baseUrl`'s origin by default.** Headers attach only to requests to `baseUrl`'s origin. Same-origin subresources are included; cross-origin requests are not — a CDN, an analytics pixel, or an absolute `visit:` to another origin gets no headers at all, so the token never leaks to a third party. Scoping is by host and ignores scheme, an artifact of how the underlying browser layer registers the interception.

Set `headersScope: all` to opt out and go back to context-wide headers — every request, all origins — for flows that legitimately span origins and need the headers on each:

```yaml
# flowspec.config.yaml
headersScope: all   # opt out of origin scoping: every request, all origins
```

**On the command line.** `flowspec run` accepts a repeatable `--header "Name: value"` flag, so CI can pass the token on the invocation instead of requiring the variable the config interpolates:

```bash
flowspec run specs/ --base-url https://myapp-preview.vercel.app --header "x-vercel-protection-bypass: $TOKEN"
```

`--header` flags **replace** the config `headers` block entirely rather than merging into it key by key — the same replacement rule a flow-level `setup` follows. Values are not `${VAR}`-interpolated: the shell has already had its chance to expand the argument, so a reference that survived quoting is sent literally. A later `--header` for a name given earlier wins. A malformed argument (no colon, or an empty name) is a one-line error and exit code 2, reported before any flow is parsed or any browser session opens. `headersScope` remains config-only.

**Validation.** FlowSpec checks header names and values itself before issuing any browser command: a name that isn't a valid HTTP token, or a value containing NUL, carriage return, or line feed, fails with the standard `Failed to apply headers: ...` error naming the offending header. The check is not redundant — under origin scoping the browser layer hangs on a bad name rather than reporting an error, and a hung flow tells the user nothing.

`headers` is config-level only; there is no `headers` block in a flow file. Header auth is a property of the environment you're pointing at, not of the behavior your app is supposed to have, so it belongs next to the `baseUrl` it goes with rather than inside the specs — the same reasoning that keeps specs immutable and human-readable (see [ADR 0003](adr/0003-config-stays-committed-var-is-the-boundary.md)).

**Failure behavior:** because `headers` always comes from the config file, a failure applying it is always a shared failure. The run aborts immediately — that flow is reported as failed with a `Failed to apply headers: ...` error, and every remaining flow is reported as skipped, exactly like a config-level `setup` failure.

**`headers` or `setup`?** Use `headers` for header-based protection (Vercel protection bypass, Netlify, an `Authorization` header); use `setup` for navigation-based auth, where visiting a URL or submitting a login form plants a session cookie (the Shopify Oxygen token URL above). They compose — configure both when a deployment needs both.

#### ${VAR} Interpolation

String values in `flowspec.config.yaml` — `baseUrl`, `specsDir`, `cwd`, any string inside `setup`, and any value inside `headers` — support `${VAR_NAME}` references, resolved from `process.env` when the config is loaded:

```yaml
baseUrl: https://preview-abc123.myshopify.dev?_ab=${PREVIEW_TOKEN}
```

This keeps tokens and secrets out of committed config files. Set `PREVIEW_TOKEN` in your shell, your CI secrets, or a `.env` file. Bun loads `.env` automatically; under Node pass `--env-file=.env` (Node 20.6+) or preload dotenv. FlowSpec itself never reads `.env` files. If you use a `.env` file, make sure it is listed in your project's `.gitignore` — moving the token out of `flowspec.config.yaml` and into a committed `.env` defeats the purpose.

- Interpolation applies to config file string *values* only — never to keys, so a header name under `headers` is never substituted. It never runs on flow spec files under `specs/`, so a literal `${...}` in a flow's `visible` assertion (or anywhere else in a spec file) is never substituted. It also never runs on CLI arguments, including `--header` values — the shell expands those.
- A referenced variable that isn't set in `process.env` is a hard error: FlowSpec exits with code 2 and prints a message naming the missing variable and the config file path, before parsing any flow file or opening any browser session.

### Exit Codes

| Code | Meaning |
| ---- | ------- |
| 0 | All flows passed |
| 1 | One or more flows failed |
| 2 | Parse error, a malformed `--header`, or a config file that fails to load or validate (invalid YAML, schema, or an unset `${VAR}`) |

A spec that mixes surfaces — a web verb (`visit`, `click`, ...) inside a `surface: cli` flow, or a `run` step inside a web flow — is a parse error and exits **2**, before any command runs or any browser opens.

## Flow File Format

Flow files use YAML with a simple structure:

```yaml
name: user-login
description: User can log in with valid credentials
steps:
  - visit: /login
  - fill:
      Email: user@example.com
      Password: secretpassword
  - click: Sign In
expect:
  - url: /dashboard
  - visible: Welcome back
```

### `surface`: web (default) or cli

An optional `surface` field picks the flow's grammar:

```yaml
surface: web   # default — omit the key entirely for the same effect
surface: cli   # this flow drives a command-line tool instead of a browser
```

Absent (or explicit `surface: web`) is the browser-driven grammar documented on this page — byte-for-byte the same behavior as every flow written before `surface` existed. `surface: cli` switches the flow's `steps`, `setup`, and `expect` to the CLI grammar described in [CLI Flows](#cli-flows-surface-cli) below. A flow may not mix the two: a web verb (`visit`, `click`, ...) inside a `surface: cli` flow, or a `run` step inside a web flow, is a parse error naming the offending verb and the flow's surface (exit code 2 — see [Exit Codes](#exit-codes)).

**Requires flowspec v0.2.0 or later.** An older FlowSpec binary silently drops the unrecognized `surface` key (top-level fields aren't strictly checked) and then tries to validate the flow's `steps` against the web-only grammar it knows — a CLI flow's `run` steps don't match any web action, so the result is a confusing parse failure rather than a clear "upgrade FlowSpec" message. Pin a minimum FlowSpec version in CI before adopting `surface: cli`.

### Setup (Optional)

A flow can declare its own `setup` block — steps that run once, in the same browser session, before `steps`. It uses the same step grammar as `steps` (see [Step Actions](#step-actions) below):

```yaml
name: admin-only-page
description: Admin user can view the settings panel
setup:
  - visit: /login
  - fill:
      Email: admin@example.com
      Password: adminpassword
  - click: Sign In
steps:
  - visit: /admin/settings
expect:
  - visible: Settings
```

A flow-level `setup` **replaces** any `setup` configured in `flowspec.config.yaml` — it does not merge with it. An explicit `setup: []` opts the flow out of setup entirely, even when the config file defines one (useful for a flow that specifically exercises the unauthenticated state). See [Setup: Shared Steps Before Every Flow](#setup-shared-steps-before-every-flow) for the config-level version and the run-abort behavior when a shared setup fails.

### Step Actions

These are the **web** step verbs (`surface: web`, the default). A `surface: cli` flow uses a different grammar entirely — see [CLI Flows](#cli-flows-surface-cli) below.

| Action | Description | Example |
| ------ | ----------- | ------- |
| `visit` | Navigate to a URL (relative or absolute) | `visit: /login` |
| `click` | Click element by visible text | `click: "Sign In"` |
| `fill` | Fill form fields by label | `fill: { Email: user@example.com }` |
| `select` | Select dropdown option by label | `select: { Country: "United States" }` |
| `wait_for` | Wait for text to appear (with retry) | `wait_for: "Loading complete"` |

### Assertions

These are the **web** assertions. A `surface: cli` flow's `expect` block uses the eight CLI assertions in [CLI Flows](#cli-flows-surface-cli) below instead.

| Assertion | Description | Example |
| --------- | ----------- | ------- |
| `url` | Check current URL contains value | `url: /dashboard` |
| `visible` | Check text is visible on page | `visible: "Welcome back"` |
| `matches` | Check page content matches regex | `matches: "Order #\\d+"` |
| `not_visible` | Check text is NOT on page | `not_visible: "Error"` |

## CLI Flows (`surface: cli`)

A `surface: cli` flow drives a command-line tool instead of a browser: its `steps` run real commands, and its `expect` block checks exit codes, captured output, and files the commands wrote — no `agent-browser` involved at all.

```yaml
name: build-succeeds
description: The production build completes and writes the expected bundle
surface: cli
steps:
  - run: "npm run build"
  - run: ["node", "-e", "console.log('done')"]
    expect_exit: 0
expect:
  - exit_code: 0
  - file_exists: dist/bundle.js
  - stdout_contains: "done"
```

### CLI Step Grammar

| Field | Required | Description |
| ----- | -------- | ----------- |
| `run` | Yes | The command to execute — a string or an array (see [No Shell, Ever](#no-shell-ever) below) |
| `stdin` | No | Text written to the command's standard input, then the stream is closed |
| `env` | No | Environment variables overlaid onto the inherited environment for this step only (does not leak to other steps) |
| `timeout` | No | Milliseconds before the command is killed. Falls back to `--step-timeout` (or its `stepTimeout` config value, or the 60000ms default) when absent |
| `expect_exit` | No | The exit code this step must produce — see [Exit Codes Within a CLI Flow](#exit-codes-within-a-cli-flow) below |

Note that a step's `timeout` is a hard deadline, not a retry window: the command is killed (`SIGTERM`, escalating to `SIGKILL` if it doesn't exit) the moment it elapses. It is a completely separate setting from the assertion retry budget, which is why the run-wide fallback for it is `--step-timeout`/`stepTimeout` rather than `--timeout`. `--timeout 0` therefore disables assertion retries without putting any command at risk of being killed.

`run` accepts two forms:

```yaml
steps:
  - run: "node build.js --mode production"        # string form
  - run: ["node", "build.js", "--flow", "a b.yaml"] # array form
```

A worked example of every optional field together:

```yaml
steps:
  - run: ["flowspec", "run", "--flow", "checkout.flow.yaml"]
    stdin: "y\n"
    env:
      NO_COLOR: "1"
    timeout: 5000
    expect_exit: 0
```

### No Shell, Ever

CLI steps never invoke a shell. The **string form** of `run` is split on whitespace only — no quote handling, no metacharacter interpretation. `run: "echo a && echo b"` runs the single command `echo` with the literal arguments `a`, `&&`, `echo`, `b` — `&&` is not chaining anything, and a quoted substring like `"two words"` is **not** reassembled into one argument; it becomes two separate, literally-quoted tokens.

Two escape hatches, for the two things a shell would otherwise be doing:

1. **An argument containing spaces or quotes** — use the **array form**, where each element is passed through untouched:

   ```yaml
   - run: ["node", "-e", "console.log('has a space')"]
   ```

2. **Pipes, redirects, globbing, `&&` chaining, or anything else that genuinely needs a shell** — invoke a shell explicitly, or wrap the logic in a script file:

   ```yaml
   - run: ["bash", "-c", "cat *.log | grep ERROR > errors.txt"]
   # or:
   - run: ["bash", "scripts/build-and-check.sh"]
   ```

Both hatches are ordinary uses of the array form — there is no special "shell mode" flag. FlowSpec spawns exactly the command you wrote; if that command happens to be a shell, the shell does its own parsing on its own arguments, same as running it by hand.

### CLI Assertions

| Assertion | Description | Example |
| --------- | ----------- | ------- |
| `exit_code` | The last step's exit code equals this value | `exit_code: 0` |
| `stdout_contains` | The last step's stdout contains this substring | `stdout_contains: "Build succeeded"` |
| `stdout_matches` | The last step's stdout matches this regex | `stdout_matches: "Order #\\d+"` |
| `stderr_contains` | The last step's stderr contains this substring | `stderr_contains: "deprecated"` |
| `stderr_matches` | The last step's stderr matches this regex | `stderr_matches: "^warning:"` |
| `file_exists` | A file exists, path resolved against the flow's working directory | `file_exists: dist/bundle.js` |
| `file_contains` | A file (path resolved the same way) contains a substring | `file_contains: { path: dist/bundle.js, text: "//# sourceMappingURL" }` |
| `json_output` | A dot-path into the last step's stdout, parsed as JSON, equals a value | `json_output: { path: "$.status", equals: "ok" }` |

`exit_code`, the `*_contains`/`*_matches` pairs, and `json_output` are checked once, immediately, against the already-captured output of the flow's last step — there's nothing to retry, since that output can't change after the command has exited. `file_exists` and `file_contains` **do** retry, polling within the flow's timeout, because the file they're checking for may still be written by something asynchronous even after the command that triggered it has returned.

### Working Directory

Every `surface: cli` flow runs its `steps` (and its own `setup`, if it has one) inside a single working directory, shared across all of them:

- **No `cwd` configured:** FlowSpec creates a fresh, empty temporary directory for the flow (prefixed `flowspec-` so a kept one is identifiable). On a passing flow, the directory is deleted afterward. On a **failing** flow, the directory is **kept**, and its absolute path is printed in the failure report — exactly the CLI analog of the web surface's failure screenshot, giving you somewhere to go look.
- **`cwd` configured** (in `flowspec.config.yaml` — see [`cwd` and `captureLimit`](#cwd-and-capturelimit-cli-surface-settings) above): that directory is used as-is and is **never** created or deleted by FlowSpec, whether the flow passes or fails. Point `cwd` at a real, already-existing directory.

### Setup for CLI Flows

A `surface: cli` flow can declare its own `setup` block, in the CLI step grammar, run before its `steps` in the same working directory:

```yaml
name: migration-runs-cleanly
surface: cli
setup:
  - run: ["node", "scripts/seed-fixture.js"]
steps:
  - run: ["node", "scripts/migrate.js"]
expect:
  - exit_code: 0
```

Config-level `setup` (web-only, see [Configuration File](#configuration-file)) is never applied to a CLI flow — only a flow's own `setup` block runs for it. A failing setup step fails the flow the same way a failing step does (see below), naming the setup step's own index; the flow's own `steps` never run.

### Exit Codes Within a CLI Flow

This is the least guessable rule in the grammar, so it's worth spelling out on its own: **`expect_exit` is honored on every step, including the last one — but only the *absence* of `expect_exit` on the final step makes its exit code non-fatal.**

- **Every step but the last** must produce the exit code it declared with `expect_exit` (default **0**, if `expect_exit` is omitted). A mismatch fails the flow immediately, at that step, and no later step runs. This is fail-fast: a setup or build step that didn't succeed makes the rest of the flow meaningless.
- **The last step** is different, precisely so a flow can assert that a command is *supposed* to fail — "this command should exit with an error" is a first-class, error-path spec, not a workaround. If the last step declares `expect_exit`, it's checked exactly like any other step. If it does **not**, its exit code is never fatal by itself: the flow proceeds to the `expect` block regardless of what the command returned, and the exit code becomes just one more thing `expect: [{ exit_code: ... }]` can check if you want it checked at all.
- **Setup steps** always use the non-final rule above — including the last step in the `setup` block. Setup has no assertion phase of its own to hand a bare exit code off to, so every setup step's exit code must match its `expect_exit` (default 0) or the flow fails.

## Quick Example

```yaml
# specs/checkout.flow.yaml
name: checkout-flow
description: |
  User completes a purchase with items in cart.
  Captures shipping/billing info and confirms order.

steps:
  - visit: "/cart"
  - click: "Proceed to Checkout"
  - fill:
      "Email": "user@example.com"
      "Shipping Address": "123 Main St"
  - click: "Place Order"

expect:
  - url: "/order/confirmation"
  - visible: "Order confirmed"
  - matches: "Order #\\d+"
```

## Development

```bash
bun install                    # Install dependencies
bun run build                  # Build CLI (required for bun link)
bun link                       # Link CLI locally as 'flowspec'
bun test                       # Run tests
bun run typecheck              # Type check
bun run lint                   # Lint with Biome
bun run lint:fix               # Auto-fix lint issues
bun run format                 # Format with Biome
bun run test:coverage          # Run with coverage
```

### Project Structure

```text
FlowSpec/
├── src/
│   ├── types.ts          # Zod schemas for FlowSpec
│   ├── parser.ts         # YAML parsing with Zod validation
│   ├── runner.ts         # Flow execution via agent-browser
│   ├── reporter.ts       # Result formatting for terminal
│   └── index.ts          # CLI entry point
├── test/
│   ├── fixtures/
│   │   ├── pages/        # HTML test fixtures
│   │   └── flows/        # YAML flow fixtures
│   └── *.test.ts         # Test files
├── docs/
│   └── specification.md  # Full framework design
└── specs/                # User flow specs (immutable)
```

## Documentation

- [Full Specification](docs/specification.md) - Complete framework design and rationale

## License

MIT
