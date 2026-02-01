# PRD-0001: Project Setup

## Overview

Set up the FlowSpec project with Bun runtime, TypeScript, and testing infrastructure.

## Goals

- Initialize a Bun/TypeScript project with proper configuration
- Set up Vitest with Playwright for browser-based testing
- Create the test fixture infrastructure (server + HTML pages)
- Establish basic source file structure with type definitions

## Dependencies

### Runtime
- **Bun** as the JavaScript runtime

### Production
| Package | Purpose |
|---------|---------|
| agent-browser | Browser automation CLI for AI agents (built on Playwright) |
| express | Test fixture server |
| js-yaml | YAML parsing |
| zod | Schema validation |

### Development
| Package | Purpose |
|---------|---------|
| typescript | Type checking and compilation |
| vitest | Test runner |
| @vitest/coverage-v8 | Coverage reporting |
| @types/express | Express type definitions |
| @types/js-yaml | js-yaml type definitions |

## Project Structure

```
FlowSpec/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .gitignore
├── src/
│   ├── index.ts          # CLI entry point
│   ├── types.ts          # Flow, Step, Assertion types
│   ├── parser.ts         # YAML parsing (stub)
│   ├── runner.ts         # Flow execution (stub)
│   └── reporter.ts       # Error formatting (stub)
├── test/
│   ├── setup.ts          # Global setup/teardown
│   ├── server.ts         # Express fixture server
│   ├── parser.test.ts    # Parser tests
│   ├── runner.test.ts    # Runner tests
│   └── fixtures/
│       ├── pages/
│       │   ├── login.html
│       │   ├── dashboard.html
│       │   └── forms.html
│       └── flows/
│           ├── valid/
│           └── invalid/
├── docs/
├── prd/
└── specs/                # Example user specs
```

## Configuration

### package.json scripts

```json
{
  "scripts": {
    "dev": "bun run src/index.ts",
    "build": "tsc",
    "test": "vitest",
    "test:coverage": "vitest --coverage",
    "typecheck": "tsc --noEmit"
  }
}
```

## Acceptance Criteria

### AC1: Dependencies install without errors
```bash
bun install
# No errors
```

### AC2: TypeScript compiles
```bash
bun run typecheck
# Exit code 0, no type errors
```

### AC3: Tests execute
```bash
bun test
# Vitest runs, test server starts/stops cleanly
```

### AC4: Browser available
```bash
bunx agent-browser install
# Chromium installs successfully
```

### AC5: Dev command runs
```bash
bun run dev
# Entry point executes without import errors
```

## Out of Scope

- Actual parser/runner implementation (future PRDs)
- CI/CD pipeline
- npm publishing configuration
- Claude Code hooks setup
- ESLint/Prettier configuration

## Tasks

1. Create `package.json` with dependencies
2. Create `tsconfig.json`
3. Create `vitest.config.ts`
4. Create `.gitignore`
5. Create `src/types.ts` with Flow schema types
6. Create stub files: `parser.ts`, `runner.ts`, `reporter.ts`, `index.ts`
7. Create `test/server.ts` Express fixture server
8. Create `test/setup.ts` global test setup
9. Create HTML fixtures in `test/fixtures/pages/`
10. Create sample YAML fixtures in `test/fixtures/flows/`
11. Create initial smoke tests
12. Run `bun install` and `bunx agent-browser install`
13. Verify all acceptance criteria pass
