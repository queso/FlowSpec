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

# Show help
flowspec --help
```

### Exit Codes

| Code | Meaning |
| ---- | ------- |
| 0 | All flows passed |
| 1 | One or more flows failed |
| 2 | Parse error (invalid YAML or schema) |

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

### Step Actions

| Action | Description | Example |
| ------ | ----------- | ------- |
| `visit` | Navigate to a URL (relative or absolute) | `visit: /login` |
| `click` | Click element by visible text | `click: "Sign In"` |
| `fill` | Fill form fields by label | `fill: { Email: user@example.com }` |
| `select` | Select dropdown option by label | `select: { Country: "United States" }` |

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
