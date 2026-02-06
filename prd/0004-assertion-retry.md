# PRD-0004: Assertion Retry/Polling

## Overview

Add implicit retry/polling to all assertion types in the FlowSpec runner. When an assertion fails, the runner should re-poll the page and re-evaluate until the assertion passes or a configurable timeout elapses. This matches the behavior of Cypress and Playwright, where assertions auto-retry against async page content.

## Goals

- All assertions (`visible`, `not_visible`, `matches`, `url`) auto-retry on failure
- Configurable timeout via `--timeout <ms>` CLI flag and `RunnerOptions`
- Sensible defaults that work for both fast static pages and slow async apps
- Existing tests and specs continue to work without modification

## Non-Goals

- Explicit `wait_for` step type (may be a future PRD)
- Configurable poll interval (hardcoded implementation detail)
- Retry logic for step execution (visit, click, fill, select)
- Stability assertions (e.g., "text never appears during timeout")

## Dependencies

Uses infrastructure from PRD-0002:
- Runner in `src/runner.ts`
- CLI entry point in `src/index.ts`
- Test suite in `test/runner.test.ts`

## Design

### Constants

| Constant | Value | Rationale |
|---|---|---|
| Default timeout | 5000ms | Matches Playwright's default for `expect` assertions |
| Poll interval | 250ms | Responsive detection without excessive process spawning |

### Retry Semantics

- On first check, if the assertion passes, return immediately (zero overhead for passing assertions on static pages).
- On failure, sleep for the poll interval, then re-check. Repeat until the assertion passes or the deadline is reached.
- On timeout, return the last assertion error.
- All four assertion types use the same retry mechanism.

### `not_visible` Behavior

`not_visible` retries the same way as other assertions. If text is present on first check, the runner retries until the text disappears or timeout. If text is absent on first check, the assertion passes immediately.

## CLI Interface

```
flowspec run <path> [options]

Options:
  --base-url <url>   Base URL for relative paths (default: http://localhost:3456)
  --timeout <ms>     Assertion retry timeout in milliseconds (default: 5000)
  --help             Show help
```

## Implementation

### `src/runner.ts`

1. Add `timeout?: number` to `RunnerOptions`
2. Add `DEFAULT_TIMEOUT = 5000` and `POLL_INTERVAL = 250` constants
3. Add `sleep(ms)` utility function
4. Rename current `executeAssertion` to `checkAssertion` (synchronous, unchanged logic)
5. New async `executeAssertion` wraps `checkAssertion` in a poll loop with deadline
6. Pass `timeout` from `runFlow` into `executeAssertion`

### `src/index.ts`

1. Add `timeout?: number` to `CliOptions`
2. Parse `--timeout <ms>` flag in `parseArgs()`
3. Pass through to `runFlow()`
4. Update help text

### `test/runner.test.ts`

1. Add `timeout: 0` to existing tests that expect assertion failures (~7 tests) so they don't wait 5 seconds
2. Add new `describe("assertion retry")` block with tests for:
   - Visible assertion retries until content appears
   - Timeout fires and fails when content never appears
   - Custom timeout is respected

### `test/fixtures/pages/delayed.html`

New fixture page with inline JS that renders text after a delay, used by retry tests.

## Verification

1. `bun test` -- all existing and new tests pass
2. `bun run typecheck` -- no type errors
3. `bun run lint` -- clean
4. Manual test: `flowspec run specs/` against an async app (data-ops) passes
