# Testing the FlowSpec Runner

## Overview

The FlowSpec runner translates human-readable YAML specifications into browser automation via agent-browser. Testing the runner requires a controlled environment where we know exactly what HTML exists, so we can verify the runner behaves correctly.

This inverts the typical relationship: normally specs test an application. Here, we use known-good HTML fixtures to test the spec runner itself.

## Test Architecture

```text
test/
├── fixtures/
│   ├── pages/           # Static HTML pages with predictable content
│   │   ├── login.html
│   │   ├── dashboard.html
│   │   ├── forms.html
│   │   └── ...
│   └── flows/           # FlowSpec YAML files targeting the fixtures
│       ├── valid/       # Specs that should pass
│       └── invalid/     # Specs that should fail (for error testing)
├── server.ts            # Local server serving fixture pages
└── runner.test.ts       # Test suite
```

## Test Server

A minimal Express server hosts the HTML fixtures on localhost during test runs:

```typescript
import express from 'express';
import path from 'path';

export function createTestServer(port = 3456) {
  const app = express();
  app.use(express.static(path.join(__dirname, 'fixtures/pages')));
  return app.listen(port);
}
```

The server starts before tests and stops after. Vitest's `globalSetup` or `beforeAll` handles this lifecycle.

## Test Categories

### 1. YAML Parsing

Verify the parser correctly handles:

- Valid specs with all field types
- Missing required fields (should error)
- Unknown step types (should error or warn)
- Malformed YAML syntax

These tests do not need a browser. They test the parsing layer in isolation.

```typescript
test('rejects spec missing name field', () => {
  const yaml = `
    steps:
      - visit: "/page"
  `;
  expect(() => parseFlowSpec(yaml)).toThrow(/name.*required/i);
});
```

### 2. Step Execution

Each step type needs dedicated test coverage.

#### visit

| Scenario | Expected Behavior |
|----------|-------------------|
| Valid URL | Page navigates successfully |
| Relative URL | Resolves against base URL |
| 404 page | Step succeeds (page loads, content may differ) |

#### click

| Scenario | Expected Behavior |
|----------|-------------------|
| Button with exact text | Clicks the button |
| Link with exact text | Clicks the link |
| Multiple matches | Clicks first match (or errors, depending on design) |
| No match | Fails with clear error message |
| Text inside nested element | Still finds and clicks |

#### fill

| Scenario | Expected Behavior |
|----------|-------------------|
| Input with associated label | Fills the input |
| Textarea with label | Fills the textarea |
| Label not found | Fails with clear error |
| Input without label | Fails (enforces accessibility) |

#### select

| Scenario | Expected Behavior |
|----------|-------------------|
| Dropdown with label | Selects the option |
| Option not in dropdown | Fails with clear error |
| Multi-select | Handles multiple values if supported |

### 3. Assertions

Each assertion type needs positive and negative test cases.

#### url

```html
<!-- fixture: redirects to /dashboard after button click -->
```

```yaml
# should pass
expect:
  - url: "/dashboard"

# should fail
expect:
  - url: "/wrong-page"
```

#### visible

```html
<p>Welcome back, user@example.com</p>
```

```yaml
# should pass
expect:
  - visible: "Welcome back"

# should fail
expect:
  - visible: "Goodbye"
```

#### matches

```html
<p>Order #12345 confirmed</p>
```

```yaml
# should pass
expect:
  - matches: "Order #\\d+ confirmed"

# should fail
expect:
  - matches: "Order #[a-z]+ confirmed"
```

#### not_visible

```html
<!-- error message hidden by default -->
<p class="error" style="display: none">Invalid credentials</p>
```

```yaml
# should pass
expect:
  - not_visible: "Invalid credentials"
```

### 4. Error Reporting

When specs fail, the runner should provide actionable error messages. Test that failures include:

- Which step or assertion failed
- What was expected vs. what was found
- Enough context to debug (element text, current URL, etc.)

```typescript
test('click failure includes button text in error', async () => {
  const result = await runFlow({
    name: 'missing-button',
    steps: [
      { visit: 'http://localhost:3456/login.html' },
      { click: 'Nonexistent Button' }
    ],
    expect: []
  });

  expect(result.passed).toBe(false);
  expect(result.error).toContain('Nonexistent Button');
  expect(result.error).toContain('click');
});
```

### 5. End-to-End Flows

Test complete flows that combine multiple steps and assertions:

```yaml
name: full-login-flow
steps:
  - visit: "/login.html"
  - fill:
      "Email": "test@example.com"
      "Password": "password123"
  - click: "Sign In"
expect:
  - url: "/dashboard.html"
  - visible: "Welcome"
  - not_visible: "Error"
```

## HTML Fixtures

Fixtures should be minimal and predictable. Each fixture tests specific runner behavior.

### login.html

```html
<!DOCTYPE html>
<html>
<head><title>Login</title></head>
<body>
  <form action="/dashboard.html">
    <label for="email">Email</label>
    <input type="email" id="email" name="email">

    <label for="password">Password</label>
    <input type="password" id="password" name="password">

    <button type="submit">Sign In</button>
  </form>
</body>
</html>
```

### dashboard.html

```html
<!DOCTYPE html>
<html>
<head><title>Dashboard</title></head>
<body>
  <h1>Welcome</h1>
  <p>You are now logged in.</p>
</body>
</html>
```

### forms.html (comprehensive form elements)

```html
<!DOCTYPE html>
<html>
<head><title>Forms</title></head>
<body>
  <label for="name">Full Name</label>
  <input type="text" id="name">

  <label for="country">Country</label>
  <select id="country">
    <option value="us">United States</option>
    <option value="ca">Canada</option>
    <option value="uk">United Kingdom</option>
  </select>

  <label for="bio">Biography</label>
  <textarea id="bio"></textarea>

  <button>Submit Form</button>
  <button>Cancel</button>
</body>
</html>
```

## Running Tests

```bash
# Run all runner tests
bun test

# Run with coverage
bun test --coverage

# Run specific test file
bun test runner.test.ts
```

## Test Configuration

### vitest.config.ts

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,  // Browser tests need longer timeout
    hookTimeout: 10000,
    globalSetup: './test/setup.ts',
  },
});
```

### test/setup.ts

```typescript
import { createTestServer } from './server';

let server: ReturnType<typeof createTestServer>;

export function setup() {
  server = createTestServer(3456);
  console.log('Test server started on port 3456');
}

export function teardown() {
  server.close();
  console.log('Test server stopped');
}
```

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
