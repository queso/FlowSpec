# PRD-0002: FlowSpec CLI

## Overview

Implement the FlowSpec command-line interface that parses YAML flow specifications and executes them via browser automation. This is the core functionality that enables deterministic CI execution of user flows.

## Goals

- Implement YAML parser that validates specs against the FlowSpec schema
- Implement deterministic runner using agent-browser CLI for browser automation
- Implement reporter that formats errors with actionable context
- Wire up CLI entry point with `run` command

## Non-Goals

- LLM/agent-driven execution mode (future PRD)
- Flow composition/reusable steps
- Parallel execution
- Screenshot capture on failure
- Watch mode

## Dependencies

Uses infrastructure from PRD-0001:
- Zod schemas in `src/types.ts`
- Test fixtures in `test/fixtures/`
- Test server in `test/server.ts`
- agent-browser CLI for browser automation

## CLI Interface

```bash
# Run single flow
flowspec run specs/checkout.flow.yaml

# Run all flows in directory
flowspec run specs/

# Run with base URL override
flowspec run specs/ --base-url http://localhost:3000

# Exit codes
# 0 = all flows passed
# 1 = one or more flows failed
# 2 = invalid spec (parse error)
```

## Module Implementation

### src/parser.ts

Parse YAML string into validated FlowSpec object.

```typescript
export function parseFlowSpec(yaml: string): FlowSpec
export function parseFlowFile(filePath: string): FlowSpec
```

**Behavior:**
- Parse YAML using js-yaml
- Validate against FlowSpec Zod schema
- Throw descriptive errors for invalid specs
- Support relative file paths

**Error cases:**
- Invalid YAML syntax
- Missing required fields (name, steps)
- Unknown step types
- Invalid assertion types

### src/runner.ts

Execute a FlowSpec against a live browser via agent-browser CLI.

```typescript
export interface RunnerOptions {
  baseUrl?: string
}

export async function runFlow(
  flow: FlowSpec,
  options?: RunnerOptions
): Promise<FlowResult>
```

**Step execution:**

| Step | Browser Action |
|------|----------------|
| `visit: "/path"` | Navigate to baseUrl + path |
| `click: "Text"` | Find element by accessible text, click it |
| `fill: { "Label": "value" }` | Find input by label, fill value |
| `select: { "Label": "option" }` | Find select by label, choose option |

**Assertion execution:**

| Assertion | Verification |
|-----------|--------------|
| `url: "/path"` | Current URL ends with path |
| `visible: "Text"` | Text is visible on page |
| `matches: "regex"` | Text matching regex is visible |
| `not_visible: "Text"` | Text is not visible |

**Element finding strategy:**

Use agent-browser's snapshot to find element refs by text/label:
1. `agent-browser snapshot -i` returns interactive elements with refs
2. Parse snapshot to find ref matching the target text/label
3. Use ref with `agent-browser click`, `fill`, or `select` commands

This aligns with FlowSpec's human-readable selector philosophy.

**Error handling:**
- Wrap each step in try/catch
- On failure, capture current URL, page snapshot
- Return FlowResult with error details

### src/reporter.ts

Format FlowResult for terminal output.

```typescript
export function formatResult(result: FlowResult): string
export function formatSummary(results: FlowResult[]): string
```

**Success output:**
```
✓ checkout-flow (1.2s)
```

**Failure output:**
```
✗ checkout-flow (0.8s)
  Step 4: click "Place Order"
  Error: Could not find element with text "Place Order"

  Current URL: http://localhost:3000/cart
  Visible buttons: "Submit Order", "Cancel", "Continue Shopping"
```

**Summary output:**
```
3 flows: 2 passed, 1 failed

Failed:
  ✗ checkout-flow
```

### src/index.ts

CLI entry point using process.argv.

```typescript
// Usage: flowspec run <path> [--base-url <url>]
```

**Behavior:**
1. Parse CLI arguments
2. Resolve flow file(s) from path
3. Parse each flow file
4. Run each flow
5. Report results
6. Exit with appropriate code

## Acceptance Criteria

### AC1: Parser validates specs

```typescript
// Valid spec parses successfully
const flow = parseFlowSpec(`
name: test-flow
steps:
  - visit: "/page"
expect:
  - visible: "Hello"
`);
expect(flow.name).toBe('test-flow');

// Invalid spec throws
expect(() => parseFlowSpec(`
steps:
  - visit: "/page"
`)).toThrow(/name.*required/i);
```

### AC2: Runner executes steps

```typescript
const result = await runFlow({
  name: 'login-test',
  steps: [
    { visit: '/login.html' },
    { fill: { 'Email': 'test@example.com' } },
    { click: 'Sign In' }
  ],
  expect: [
    { url: '/dashboard.html' }
  ]
}, { baseUrl: 'http://localhost:3456' });

expect(result.passed).toBe(true);
```

### AC3: Runner reports step failures

```typescript
const result = await runFlow({
  name: 'missing-button',
  steps: [
    { visit: '/login.html' },
    { click: 'Nonexistent Button' }
  ],
  expect: []
}, { baseUrl: 'http://localhost:3456' });

expect(result.passed).toBe(false);
expect(result.error?.step).toBe(1);
expect(result.error?.action).toBe('click');
expect(result.error?.message).toContain('Nonexistent Button');
```

### AC4: Runner reports assertion failures

```typescript
const result = await runFlow({
  name: 'wrong-url',
  steps: [
    { visit: '/login.html' }
  ],
  expect: [
    { url: '/dashboard.html' }
  ]
}, { baseUrl: 'http://localhost:3456' });

expect(result.passed).toBe(false);
expect(result.error?.assertion).toBe('url');
```

### AC5: CLI runs flows

```bash
bun run dev run test/fixtures/flows/valid/login.flow.yaml --base-url http://localhost:3456
# Exit code 0, output shows pass

bun run dev run test/fixtures/flows/invalid/
# Exit code 1, output shows failures
```

### AC6: Reporter formats output

```typescript
const output = formatResult({
  flow: 'checkout-flow',
  passed: false,
  duration: 800,
  error: {
    step: 3,
    action: 'click',
    message: 'Could not find "Place Order"'
  }
});

expect(output).toContain('✗ checkout-flow');
expect(output).toContain('Step 3');
expect(output).toContain('Place Order');
```

## Test Plan

### Unit Tests

1. **Parser tests** (`test/parser.test.ts`)
   - Valid specs with all field types
   - Missing required fields
   - Unknown step/assertion types
   - Malformed YAML

2. **Reporter tests** (`test/reporter.test.ts`)
   - Success formatting
   - Failure formatting with context
   - Summary formatting

### Integration Tests

3. **Runner tests** (`test/runner.test.ts`)
   - Each step type against HTML fixtures
   - Each assertion type
   - Error capture and reporting
   - Full end-to-end flows

### CLI Tests

4. **CLI tests** (`test/cli.test.ts`)
   - Argument parsing
   - Exit codes
   - Output formatting

## Implementation Notes

### Browser Automation

The runner uses agent-browser CLI for browser automation. Key commands:

```bash
agent-browser open <url>        # Navigate to URL
agent-browser snapshot          # Get page text content
agent-browser snapshot -i       # Get interactive elements with refs
agent-browser click <ref>       # Click element by ref
agent-browser fill <ref> "val"  # Fill input by ref
agent-browser select <ref> "opt" # Select option by ref
```

### Element Finding

Parse the snapshot output to find element refs by human-readable text:

```typescript
import { execSync } from 'child_process';

function ab(command: string): string {
  return execSync(`agent-browser ${command}`, { encoding: 'utf-8' });
}

// For click: "Place Order"
const snapshot = ab('snapshot -i');
const ref = findRefByText(snapshot, 'Place Order');
ab(`click ${ref}`);

// For fill: { "Email": "value" }
const snapshot = ab('snapshot -i');
const ref = findRefByLabel(snapshot, 'Email');
ab(`fill ${ref} "user@example.com"`);

// For select: { "Country": "Canada" }
const snapshot = ab('snapshot -i');
const ref = findRefByLabel(snapshot, 'Country');
ab(`select ${ref} "Canada"`);
```

### Timeout Handling

- Default step timeout: 5 seconds
- Default flow timeout: 30 seconds
- Timeouts should be configurable via CLI flags (future enhancement)

## Tasks

1. Implement `src/parser.ts` with Zod validation
2. Write parser unit tests
3. Implement `src/runner.ts` with agent-browser CLI
4. Write runner integration tests against fixtures
5. Implement `src/reporter.ts` with formatted output
6. Write reporter unit tests
7. Wire up `src/index.ts` CLI with arg parsing
8. Write CLI integration tests
9. Add valid/invalid flow fixtures for testing
10. End-to-end test: run CLI against fixture server
