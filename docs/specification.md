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
    "preToolUse": [
      {
        "matcher": {
          "tool": ["Edit", "Write"],
          "filePath": "specs/**/*.flow.yaml"
        },
        "command": "echo 'BLOCKED: FlowSpec files are immutable. Fix the implementation to match the spec.' && exit 1"
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

steps:                          # Ordered user actions
  - visit: "/path"              # Navigate to URL
  - click: "Button Text"        # Click element by visible text
  - fill:                       # Fill form fields by label
      "Label": "value"
  - select:                     # Select dropdown option by label
      "Label": "option"

expect:                         # Assertions after steps complete
  - url: "/expected/path"       # Current URL matches
  - visible: "Expected text"    # Text is visible on page
  - matches: "regex pattern"    # Text matching pattern is visible
  - not_visible: "Text"         # Text is not visible
```

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
│   └── settings.json          # Contains hooks config
└── package.json
```

## Claude Code Integration

### Hook Configuration

Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "preToolUse": [
      {
        "matcher": {
          "tool": ["Edit", "Write"],
          "filePath": "specs/**/*.flow.yaml"
        },
        "command": "echo 'BLOCKED: FlowSpec files are immutable. Fix the implementation to match the spec.' && exit 1"
      }
    ]
  }
}
```

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
