# Changelog

All notable changes to FlowSpec will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`flowspec init` Command**
  - Scaffolds new FlowSpec projects with `flowspec init`
  - Creates `flowspec.config.yaml` with default settings
  - Creates `specs/` directory with example flow
  - Sets up `.claude/settings.local.json` with PreToolUse hook to protect specs from AI modification
  - Updates `package.json` with `test:e2e` script

- **Config File Support**
  - `flowspec.config.yaml` for project-level configuration
  - Settings: `baseUrl`, `timeout`, `specsDir`
  - CLI options override config file values
  - Config file discovery walks up directory tree

- **`wait_for` Step Type**
  - New step action: `wait_for: "Text"` waits for text to appear before continuing
  - Uses same retry/polling logic as assertions (respects `--timeout`)
  - Useful for async UI updates (e.g., waiting for AI responses, loading states)

- **Assertion Retry/Polling** (PRD-0004)
  - Assertions now auto-retry on failure until pass or timeout elapses
  - `--timeout <ms>` CLI flag to configure retry timeout (default: 5000ms)
  - `timeout` option in `RunnerOptions` for programmatic control
  - All assertion types (`visible`, `not_visible`, `matches`, `url`) support retry
  - `timeout: 0` disables retries for instant failure (useful for tests)
  - New constants: `DEFAULT_TIMEOUT` (5000ms), `POLL_INTERVAL` (250ms)

- **FlowSpec CLI** (PRD-0002)
  - `flowspec run <path>` command to execute flow specifications
  - `--base-url <url>` option for configuring the target server
  - Exit codes: 0 (pass), 1 (fail), 2 (parse error)

- **YAML Parser** (`src/parser.ts`)
  - `parseFlowSpec(yaml)` - Parse YAML string to FlowSpec object
  - `parseFlowFile(path)` - Parse flow file from disk
  - Zod schema validation with human-readable error messages
  - YAML syntax error reporting with line/column information

- **Result Reporter** (`src/reporter.ts`)
  - `formatResult(result)` - Format single flow result with colors
  - `formatSummary(results)` - Format summary of all results
  - `formatError(error)` - Format error details with step context
  - ANSI color output (green checkmark for pass, red X for fail)

- **Flow Runner** (`src/runner.ts`)
  - `runFlow(flow, options)` - Execute a FlowSpec with browser automation
  - Browser automation via `agent-browser` CLI
  - Step actions: visit, click, fill, select
  - Assertions: url, visible, matches, not_visible
  - Isolated browser sessions per flow execution
  - Shell escaping for secure command execution

- **Biome linter and formatter** (`biome.json`)
  - Fast Rust-based linting and formatting
  - Replaces ESLint + Prettier with single tool
  - Scripts: `lint`, `lint:fix`, `format`

- **Project infrastructure** (PRD-0001)
  - Bun/TypeScript project with strict configuration
  - Vitest test runner with coverage support
  - Express-based test fixture server for E2E testing

- **Core type definitions** (`src/types.ts`)
  - `FlowSpec` - Complete flow specification schema
  - `FlowStep` - Individual step actions (visit, click, fill, select)
  - `StepAssertion` - Assertion types (url, visible, matches, not_visible)
  - `FlowResult` - Execution result with timing and errors
  - `FlowError` - Structured error information
  - All types use Zod for runtime validation

- **Test fixtures**
  - HTML pages: login, dashboard, forms (for browser testing)
  - YAML flows: valid and invalid examples (for parser testing)

- **Test infrastructure**
  - Test fixture server with start/stop lifecycle
  - 111+ tests covering parser, reporter, CLI
