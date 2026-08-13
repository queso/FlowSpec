/**
 * Tests for WI-771: render setup failures and skipped flows distinctly in
 * reporter output.
 *
 * Contract pinned by the work item:
 *  - A FlowError with phase: "setup" renders "Setup step N: ..." (not
 *    "Step N: ...") in both formatError and formatResult.
 *  - A FlowError with no phase renders exactly as it does today.
 *  - formatSummary appends ", N skipped" only when N > 0, and skipped
 *    results must not be folded into the failed count.
 *  - A skipped FlowResult (success: false, skipped: true) shows neither the
 *    green nor red marker, and prints no step line, error line, or duration.
 */

import { describe, expect, it } from "vitest";
import { formatError, formatResult, formatSummary } from "../src/reporter";
import type { FlowError, FlowResult } from "../src/types";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";

describe("formatError setup phase", () => {
  it("prefixes the step line with 'Setup' when phase is 'setup', not plain 'Step'", () => {
    const error: FlowError = {
      message: "Could not find element",
      phase: "setup",
      step: 0,
      action: { click: "Login" },
    };

    const output = formatError(error);

    expect(output).toContain('Setup step 0: click "Login"');
    // Exclusivity: no bare "Step 0:" line without the "Setup" prefix.
    expect(output).not.toMatch(/(?<!Setup )Step 0:/);
  });

  it("renders exactly as it does today when phase is absent (regression)", () => {
    const error: FlowError = {
      message: "Element not found",
      step: 2,
      action: { click: "Submit" },
    };

    const output = formatError(error);

    expect(output).toBe('Step 2: click "Submit"\n  Error: Element not found');
  });
});

describe("formatResult setup phase", () => {
  it("prefixes the step line with 'Setup' when the error's phase is 'setup', not plain 'Step'", () => {
    const result: FlowResult = {
      success: false,
      flowName: "auth-flow",
      duration: 75,
      error: {
        message: "Could not find element",
        phase: "setup",
        step: 0,
        action: { click: "Login" },
      },
    };

    const output = formatResult(result);

    expect(output).toContain('Setup step 0: click "Login"');
    expect(output).not.toMatch(/(?<!Setup )Step 0:/);
  });

  it("renders exactly as it does today for a failure with no phase (regression)", () => {
    const result: FlowResult = {
      success: false,
      flowName: "broken-flow",
      duration: 456,
      error: {
        message: "Element not found",
        step: 2,
        action: { click: "Submit" },
      },
    };

    const output = formatResult(result);

    expect(output).toBe(
      '\x1b[31m✗ broken-flow (456ms)\x1b[0m\n  Step 2: click "Submit"\n  Error: Element not found',
    );
  });
});

describe("formatResult skipped flow", () => {
  it("marks a skipped flow visibly without the green success or red failure marker", () => {
    const result: FlowResult = {
      success: false,
      flowName: "unreached-flow",
      duration: 0,
      skipped: true,
    };

    const output = formatResult(result);

    expect(output).toContain("unreached-flow");
    expect(output).toMatch(/skip/i);
    expect(output).not.toContain(GREEN);
    expect(output).not.toContain(RED);
  });

  it("prints no step line, no error line, and no duration for a skipped flow, even if an error is present", () => {
    // Adversarial construction: an error happens to be present alongside
    // skipped: true. Skipped must still win — no step/error/duration output
    // for a flow that never ran.
    const result: FlowResult = {
      success: false,
      flowName: "unreached-flow",
      duration: 999,
      skipped: true,
      error: {
        message: "should not be rendered",
        step: 3,
        action: { click: "Never Ran" },
      },
    };

    const output = formatResult(result);

    expect(output).not.toMatch(/Step \d+:/);
    expect(output).not.toContain("Error:");
    expect(output).not.toContain("should not be rendered");
    expect(output).not.toContain("999ms");
  });
});

describe("formatSummary skipped count", () => {
  it("appends a skipped count when at least one result is skipped", () => {
    const results: FlowResult[] = [
      { success: false, flowName: "a", duration: 0, skipped: true },
      { success: false, flowName: "b", duration: 0, skipped: true },
      {
        success: false,
        flowName: "c",
        duration: 10,
        error: { message: "boom" },
      },
    ];

    const output = formatSummary(results);

    expect(output).toBe("3 flows: 0 passed, 1 failed, 2 skipped");
  });

  it("emits the current string byte-for-byte when no results are skipped", () => {
    const results: FlowResult[] = [
      { success: true, flowName: "a", duration: 1 },
      { success: false, flowName: "b", duration: 2, error: { message: "x" } },
    ];

    const output = formatSummary(results);

    expect(output).toBe("2 flows: 1 passed, 1 failed");
  });

  it("counts skipped results as skipped rather than folding them into the failed count", () => {
    const results: FlowResult[] = [
      { success: true, flowName: "a", duration: 1 },
      { success: false, flowName: "b", duration: 0, skipped: true },
    ];

    const output = formatSummary(results);

    expect(output).toBe("2 flows: 1 passed, 0 failed, 1 skipped");
  });

  it("never reports a negative count for a contract-violating success+skipped result", () => {
    // Adversarial construction: {success: true, skipped: true} is schema-legal
    // (both fields independent in FlowResultSchema) but violates the runner's
    // contract. Deriving failed by subtraction double-counts it and underflows.
    const results: FlowResult[] = [
      { success: true, flowName: "a", duration: 1, skipped: true },
    ];

    const output = formatSummary(results);

    expect(output).not.toMatch(/-\d/);
    expect(output).toBe("1 flow: 0 passed, 0 failed, 1 skipped");
  });

  it("counts a contract-violating success+skipped result as skipped, not passed, without losing real failures", () => {
    const results: FlowResult[] = [
      { success: true, flowName: "a", duration: 1 },
      { success: false, flowName: "b", duration: 2, error: { message: "x" } },
      { success: true, flowName: "c", duration: 0, skipped: true },
    ];

    const output = formatSummary(results);

    expect(output).not.toMatch(/-\d/);
    // The malformed result lands in skipped only; the genuine failure survives.
    expect(output).toBe("3 flows: 1 passed, 1 failed, 1 skipped");
  });

  it("treats skipped: false the same as skipped being omitted (not counted as skipped)", () => {
    const results: FlowResult[] = [
      { success: true, flowName: "a", duration: 1, skipped: false },
      {
        success: false,
        flowName: "b",
        duration: 2,
        error: { message: "x" },
        skipped: false,
      },
    ];

    const output = formatSummary(results);

    expect(output).toBe("2 flows: 1 passed, 1 failed");
  });
});
