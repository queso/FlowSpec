# Testing the FlowSpec Runner

## Overview

The FlowSpec runner translates human-readable YAML specifications into browser automation via agent-browser. Testing the runner requires a controlled environment where we know exactly what HTML exists, so we can verify the runner behaves correctly.

This inverts the typical relationship: normally specs test an application. Here, we use known-good HTML fixtures to test the spec runner itself.

## Test Architecture

```text
test/
├── fixtures/
│   ├── pages/                    # Static HTML served to the browser
│   │   ├── login.html
│   │   ├── dashboard.html
│   │   ├── forms.html
│   │   └── delayed.html
│   └── flows/                    # YAML files used for schema validation only
│       ├── valid/                # Must pass FlowSpecSchema
│       └── invalid/              # Must fail FlowSpecSchema
├── helpers/
│   └── has-browser.ts            # Detects installed Playwright binaries
├── server.ts                     # Express server for fixture pages
├── parser*.test.ts               # Parsing, strict mode, edge cases, security
├── types.test.ts                 # Zod schema behavior
├── config.test.ts                # Project config + flowspec.config.yaml loading
├── init*.test.ts                 # flowspec init, monorepo detection, --dir
├── cli*.test.ts                  # CLI entry point and timeout handling
├── flows.test.ts                 # YAML fixture files against the schema
├── fixtures.test.ts              # Fixture files exist and are well-formed
├── server.test.ts                # The fixture server itself
├── runner.test.ts                # Step execution + assertions (browser)
└── runner-retry.test.ts          # Assertion retry/polling (browser)
```

### Two layers of tests

Most of the suite runs without a browser. Only `runner.test.ts` and
`runner-retry.test.ts` drive agent-browser, and both skip themselves when
Playwright binaries are absent:

```typescript
import { hasBrowserBinaries } from './helpers/has-browser';

const describeIfAgentBrowser = hasBrowserBinaries() ? describe : describe.skip;

describeIfAgentBrowser('Flow Runner', () => { /* ... */ });
```

`hasBrowserBinaries()` does a filesystem check for the Playwright cache rather
than spawning a process, because spawning hangs when the binaries are missing.

Note that `test/fixtures/flows/` is **not** executed against a browser. Those
files exist so `flows.test.ts` can assert that the valid ones pass
`FlowSpecSchema` and the invalid ones fail it. They use extensionless paths
(`visit: /login`) that the static fixture server does not resolve. Runner tests
build `FlowSpec` objects inline and use real `.html` paths.

## Test Server

A minimal Express server hosts the HTML fixtures on localhost during test runs:

```typescript
export interface TestServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly port: number;     // defaults to TEST_SERVER_PORT env var, or 3456
  readonly baseUrl: string;  // e.g. "http://localhost:3456"
}

export function createTestServer(options?: {
  port?: number;
  fixturesDir?: string;      // defaults to test/fixtures/pages
}): TestServer;
```

It serves static files only — no routing, no redirects. Requests must include
the `.html` extension.

Tests that need it start it per-file and pass `server.baseUrl` into `runFlow`:

```typescript
const server: TestServer = createTestServer();

beforeAll(async () => {
  await server.start();
});

afterAll(async () => {
  await server.stop();
});
```

## Test Categories

### 1. YAML Parsing

Verify the parser correctly handles:

- Valid specs with all field types
- Missing required fields (should error)
- Unknown step types (should error)
- Malformed YAML syntax
- Prototype-pollution and other malicious YAML input (`parser-security.test.ts`)

These tests do not need a browser. They test the parsing layer in isolation.

```typescript
it('rejects spec missing name field', () => {
  const yaml = `
    description: A flow with no name
    steps:
      - visit: "/page"
    expect:
      - visible: "Home"
  `;
  expect(() => parseFlowSpec(yaml)).toThrow();
});
```

Schemas are strict (`.strict()`), so unknown keys inside a step or assertion are
rejected rather than ignored. `steps` and `expect` both require at least one
entry, and `name` and `description` are both required.

### 2. Step Execution

Each step type needs dedicated test coverage.

#### visit

| Scenario | Expected Behavior |
|----------|-------------------|
| Absolute URL | Page navigates successfully |
| Relative URL | Resolves against `baseUrl` |
| No `baseUrl` given | Falls back to `http://localhost:3456` |

#### click

| Scenario | Expected Behavior |
|----------|-------------------|
| Button with exact text | Clicks the button |
| Link with exact text | Clicks the link |
| No match | Fails, error names the missing text and the current URL |
| Text inside nested element | Still finds and clicks |

#### fill

| Scenario | Expected Behavior |
|----------|-------------------|
| Input with associated label | Fills the input |
| Textarea with label | Fills the textarea |
| Multiple fields in one step | All fields filled |
| Label not found | Fails with clear error |
| Input without label | Fails (enforces accessibility) |

#### select

| Scenario | Expected Behavior |
|----------|-------------------|
| Dropdown with label | Selects the option by visible text |
| Option not in dropdown | Fails with clear error |

#### wait_for

Waits for text to appear before continuing, for content that loads
asynchronously.

| Scenario | Expected Behavior |
|----------|-------------------|
| Text already present | Continues immediately |
| Text appears within timeout | Continues once it appears |
| Text never appears | Fails; error captures step index and action |

```yaml
steps:
  - visit: "/delayed.html"
  - wait_for: "Delayed Content Loaded"
```

### 3. Assertions

Each assertion type needs positive and negative test cases. Examples below use
the real fixtures.

#### url

```yaml
# passes after visiting /dashboard.html
expect:
  - url: "/dashboard.html"
```

Compares against the end of the current URL.

#### visible

`dashboard.html` contains `Welcome back, User!`:

```yaml
# should pass
expect:
  - visible: "Welcome back"

# should fail
expect:
  - visible: "Goodbye"
```

#### matches

Treats the value as a regular expression tested against page content.
`dashboard.html` contains `Projects: 12`:

```yaml
# should pass
expect:
  - matches: "Projects: \\d+"

# should fail
expect:
  - matches: "Projects: [a-z]+"
```

#### not_visible

`login.html` has an error container that is empty and `display: none` by
default:

```html
<div id="error-message" class="error-message"></div>
```

```yaml
# should pass on a fresh page load
expect:
  - not_visible: "Invalid credentials"
```

### 4. Assertion Retry

Assertions poll rather than checking once, so specs do not have to encode
arbitrary sleeps. The runner retries every `POLL_INTERVAL` (250ms) until
`timeout` elapses (default `DEFAULT_TIMEOUT`, 5000ms; override per run via
`RunnerOptions.timeout`).

`delayed.html` injects `Delayed Content Loaded` after 3 seconds, which gives
retry behavior something deterministic to test:

| Scenario | Expected Behavior |
|----------|-------------------|
| Content appears within timeout | Passes; `duration` reflects the wait |
| Content never appears | Fails after the timeout |
| Timeout shorter than the delay | Fails |
| `timeout: 0` | Fails immediately, no retry |

### 5. Error Reporting

When specs fail, the runner should provide actionable errors. `FlowResult` is:

```typescript
{
  success: boolean;
  flowName: string;
  duration: number;
  error?: {
    message: string;
    step?: number;          // 0-indexed
    action?: StepAction;    // the step that failed
    assertion?: StepAssertion;
    screenshot?: string;
  };
}
```

Note it is `success`, not `passed`, and `error` is a structured object rather
than a string.

```typescript
it('captures the step index and action on failure', async () => {
  const flow: FlowSpec = {
    name: 'step-failure',
    description: 'Fail on a specific step',
    steps: [
      { visit: '/login.html' },
      { click: 'Nonexistent Button' },
    ],
    expect: [{ visible: 'Success' }],
  };

  const result = await runFlow(flow, { baseUrl: server.baseUrl });

  expect(result.success).toBe(false);
  expect(result.error?.step).toBe(1);
  expect(result.error?.action).toEqual({ click: 'Nonexistent Button' });
});
```

Failure messages also include the current URL, so a flow that silently landed on
the wrong page is diagnosable from the error alone.

### 6. End-to-End Flows

Test complete flows that combine multiple steps and assertions:

```yaml
name: dashboard-navigation
description: User can navigate through dashboard pages
steps:
  - visit: /dashboard
  - click: Settings
  - click: Profile
  - click: Home
expect:
  - url: /dashboard
  - visible: Welcome back
  - visible: Recent Activity
```

## HTML Fixtures

Fixtures are minimal and predictable. Each one exists to exercise specific
runner behavior. Rather than duplicating the markup here (which drifts), this
lists what each fixture provides.

### login.html

| Element | Text / Label |
|---------|--------------|
| Heading | `Sign In` |
| Labeled inputs | `Email`, `Password` |
| Submit button | `Sign In` |
| Hidden error container | `#error-message`, empty and `display: none` |

Exercises `fill` by label, `click` on a submit button, and `not_visible`.

### dashboard.html

| Element | Text |
|---------|------|
| Heading | `Dashboard` |
| Nav links | `Home`, `Settings`, `Profile`, `Logout` |
| Welcome line | `Welcome back, User!` |
| Cards | `Recent Activity`, `Quick Stats`, `Updates` |
| Card content | `You have 5 new notifications.`, `Projects: 12`, `Tasks: 48` |

Exercises `click` on links, `visible`, and `matches` against numeric content.

### forms.html

| Element | Label / Text |
|---------|--------------|
| Text input | `Name` |
| Select | `Category` — `General Inquiry`, `Technical Support`, `Sales`, `Feedback` |
| Textarea | `Message` |
| Buttons | `Submit`, `Cancel` |

Exercises every `fill` target type plus `select` by visible option text.

### delayed.html

Injects a `Delayed Content Loaded` element after 3000ms. Exercises `wait_for`
and assertion retry.

## Running Tests

```bash
# Run all tests
bun run test

# Run with coverage
bun run test:coverage

# Run a single test file (partial match)
bun test runner.test.ts
```

Use `bun run test` rather than a bare `bun test` — the script supplies the
timeout the browser tests need. Running a single file directly is fine for the
non-browser tests; add `--timeout 30000` when targeting `runner.test.ts` or
`runner-retry.test.ts`.

Browser tests need Playwright binaries. Without them they skip rather than fail:

```bash
bunx agent-browser install --with-deps
```

## Test Configuration

Tests run on Bun's built-in test runner — there is no separate runner config
file. The only configuration is the test scripts in `package.json`:

```json
{
  "scripts": {
    "test": "bun test --timeout 30000",
    "test:coverage": "bun test --coverage --timeout 30000"
  }
}
```

The explicit timeout is required: Bun defaults to 5s, which the browser-driven
tests in `runner.test.ts` and `runner-retry.test.ts` exceed. CI runs
`bun run test` so the timeout is defined in exactly one place.

Test files import from `"vitest"`:

```typescript
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
```

Bun maps that import to `bun:test` automatically, so no Vitest install is
needed. Keep this import style when adding tests — it's what the existing
suite uses.

## Design Decisions

### Why static HTML fixtures?

Using static files rather than a real application:

- Makes tests deterministic and fast
- Removes external dependencies
- Allows precise control over what the runner encounters
- Enables testing edge cases that might be hard to create in a real app

### Why test failing specs?

The runner's error handling is as important as its success path. When a spec fails, developers need clear feedback about what went wrong. Testing failure modes ensures error messages are helpful.

### Why not mock agent-browser?

Mocking agent-browser would test our mock, not the actual browser behavior. Real browser tests catch issues like:

- Timing and race conditions
- Actual element visibility rules
- Real form submission behavior
- Browser-specific quirks

The overhead is worth the confidence.

### Why skip instead of fail without browsers?

Contributors working on the parser, CLI, or init logic shouldn't need a
Playwright install to get a green suite. CI installs the binaries, so the
browser tests always run there — the skip is a local-development affordance,
not a way to avoid the coverage.
