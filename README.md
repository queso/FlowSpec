# FlowSpec

Immutable user flow specifications for the age of agentic coding.

## The Problem

AI coding agents can modify both implementation and tests. When a test fails, the agent might "fix" the test instead of fixing the bug. This breaks the feedback loop that catches regressions.

## The Solution

FlowSpec separates **what your app should do** (immutable specs) from **how it does it** (agent-modifiable code).

- Write user flows in simple YAML
- Use human-readable labels (accessibility-first, à la React Testing Library)
- Protect specs from agent modification via Claude Code hooks
- Run deterministically in CI or interactively with an agent

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

```bash
npx flowspec run specs/checkout.flow.yaml
```

## Development

```bash
bun install                    # Install dependencies
bun run dev                    # Run CLI (stub)
bun test                       # Run tests
bun run typecheck              # Type check
bun run test:coverage          # Run with coverage
```

### Project Structure

```text
FlowSpec/
├── src/
│   ├── types.ts          # Zod schemas for FlowSpec
│   ├── parser.ts         # YAML parsing (stub)
│   ├── runner.ts         # Flow execution (stub)
│   ├── reporter.ts       # Error formatting (stub)
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
