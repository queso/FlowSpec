# Changelog

All notable changes to FlowSpec will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

- **Module stubs** (to be implemented in future PRDs)
  - `src/parser.ts` - YAML parsing (stub)
  - `src/runner.ts` - Flow execution (stub)
  - `src/reporter.ts` - Error formatting (stub)
  - `src/index.ts` - CLI entry point (stub)

- **Test fixtures**
  - HTML pages: login, dashboard, forms (for browser testing)
  - YAML flows: valid and invalid examples (for parser testing)

- **Test infrastructure**
  - Test fixture server with start/stop lifecycle
  - 25 MVP infrastructure tests
