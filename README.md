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

# Send an extra HTTP header (repeatable)
flowspec run specs/ --header "x-vercel-protection-bypass: $BYPASS_TOKEN"

# Show help
flowspec --help
```

### Configuration File

FlowSpec looks for `flowspec.config.yaml` in the current directory or parent directories:

```yaml
baseUrl: http://localhost:3000
timeout: 10000
specsDir: specs/
```

CLI options override config file values.

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

String values in `flowspec.config.yaml` — `baseUrl`, `specsDir`, any string inside `setup`, and any value inside `headers` — support `${VAR_NAME}` references, resolved from `process.env` when the config is loaded:

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

| Action | Description | Example |
| ------ | ----------- | ------- |
| `visit` | Navigate to a URL (relative or absolute) | `visit: /login` |
| `click` | Click element by visible text | `click: "Sign In"` |
| `fill` | Fill form fields by label | `fill: { Email: user@example.com }` |
| `select` | Select dropdown option by label | `select: { Country: "United States" }` |
| `wait_for` | Wait for text to appear (with retry) | `wait_for: "Loading complete"` |

### Assertions

| Assertion | Description | Example |
| --------- | ----------- | ------- |
| `url` | Check current URL contains value | `url: /dashboard` |
| `visible` | Check text is visible on page | `visible: "Welcome back"` |
| `matches` | Check page content matches regex | `matches: "Order #\\d+"` |
| `not_visible` | Check text is NOT on page | `not_visible: "Error"` |

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
