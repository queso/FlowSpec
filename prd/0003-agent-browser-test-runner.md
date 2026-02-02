# PRD-0003: Agent-Browser Integration Test Runner

## Type

Spike

## Problem Statement

The runner tests (`test/runner.test.ts`) timeout when executed via `bun test` because `agent-browser` CLI commands hang when spawned via `execSync` in the test environment. The same commands work correctly when run directly from the shell.

### Known Symptoms

- Tests timeout after 10 seconds (or 30 seconds with extended timeout)
- `agent-browser` process spawns but never completes
- Vitest kills "dangling processes" after test timeout
- 25 runner tests affected, all requiring browser automation

### What Works

- `agent-browser` commands execute correctly from terminal
- Parser tests pass (no browser dependency)
- Reporter tests pass (no browser dependency)
- CLI argument parsing tests pass (mock browser calls timeout)

## Goal

Investigate the root cause and create a dedicated test runner for integration tests that require `agent-browser`.

## Spike Deliverables

1. **Root Cause Analysis**
   - Document why `execSync` behaves differently in Vitest vs shell
   - Identify if it's a Bun-specific issue, Vitest issue, or TTY/stdin issue
   - Test with different spawn methods (`spawn`, `spawnSync`, `exec`)

2. **Proposed Solution**
   - Design a test runner approach that works with `agent-browser`
   - Consider: separate test command, test tagging, environment detection
   - Document tradeoffs of each approach

3. **Proof of Concept**
   - Implement minimal working solution for one test
   - Verify it runs in CI environment (if applicable)

## Out of Scope

- Rewriting the runner to not use `agent-browser`
- Mocking browser automation entirely
- Changes to `agent-browser` itself

## Acceptance Criteria

- [ ] Root cause documented in spike findings
- [ ] At least one proposed solution with tradeoffs
- [ ] One runner test executes successfully with new approach
- [ ] README updated with instructions for running integration tests

## Notes

This is exploratory work. The spike may conclude that a different architecture is needed, which would become a separate PRD.
