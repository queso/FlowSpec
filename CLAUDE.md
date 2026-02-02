# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test Commands

```bash
bun install              # Install dependencies
bun test                 # Run all tests
bun test test/types      # Run single test file (partial match)
bun run typecheck        # Type check with tsc
bun run lint             # Lint with Biome
bun run lint:fix         # Auto-fix lint issues
bun run format           # Format code with Biome
bun run dev              # Run CLI entry point
bun run test:coverage    # Run tests with coverage
```

## Architecture

FlowSpec is a framework for immutable user flow specifications. The core idea: specs in `specs/` define *what* the app should do and are protected from agent modification. Implementation code is freely modifiable.

### Core Types (`src/types.ts`)

All types use Zod schemas for runtime validation:

- **FlowSpec** - Complete flow: `{ name, description, steps[], expect[] }`
- **FlowStep** - Actions: `visit`, `click`, `fill`, `select`
- **StepAssertion** - Assertions: `url`, `visible`, `matches`, `not_visible`
- **FlowResult** - Execution result with timing and optional error
- **FlowError** - Structured error with step/action context

### Module Structure

- `src/parser.ts` - YAML → FlowSpec (stub)
- `src/runner.ts` - Execute flows via browser automation (stub)
- `src/reporter.ts` - Format errors for output (stub)
- `src/index.ts` - CLI entry point

### Test Fixtures

- `test/fixtures/pages/` - HTML pages for browser testing
- `test/fixtures/flows/` - Valid/invalid YAML flow examples
- `test/server.ts` - Express server for serving fixtures

## A(i)-Team Workflow

This project uses A(i)-Team for PRD-driven development. **Do not implement PRD features directly.**

```bash
/ateam plan prd/feature.md   # Decompose PRD into work items
/ateam run                   # Execute with TDD pipeline
/ateam status                # Check progress
```

The pipeline: test → implement → review → probe → done

## Intent Layer

No child AGENTS.md files currently needed (src/ <1k tokens, test/ <4k tokens).

### Global Invariants

- **Specs are immutable**: Files in `specs/**/*.flow.yaml` define *what* the app should do. When a spec fails, fix the implementation—not the spec.
- **Human-readable selectors**: Flows use visible text labels (e.g., `click: "Place Order"`) not CSS selectors or test IDs.
- **Zod is the source of truth**: All FlowSpec types derive from Zod schemas in `src/types.ts`.
