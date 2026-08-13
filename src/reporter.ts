import type { FlowError, FlowResult, StepAction } from "./types.js";

// ANSI color codes
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/**
 * Format duration for display
 * Uses seconds for durations >= 1000ms, otherwise milliseconds
 */
function formatDuration(ms: number): string {
  if (ms >= 1000) {
    return `${ms / 1000}s`;
  }
  return `${ms}ms`;
}

/**
 * Format a StepAction into a human-readable string
 */
function formatAction(action: StepAction): string {
  if ("visit" in action) {
    return `visit "${action.visit}"`;
  }
  if ("click" in action) {
    return `click "${action.click}"`;
  }
  if ("fill" in action) {
    return "fill";
  }
  if ("select" in action) {
    return "select";
  }
  return "unknown action";
}

/**
 * Format a FlowError into a human-readable string
 * @param error - The FlowError to format
 * @returns Formatted error message
 */
export function formatError(error: FlowError): string {
  const parts: string[] = [];

  if (error.step !== undefined && error.action) {
    const stepLabel = error.phase === "setup" ? "Setup step" : "Step";
    parts.push(`${stepLabel} ${error.step}: ${formatAction(error.action)}`);
  }

  parts.push(`Error: ${error.message}`);

  return parts.join("\n  ");
}

/**
 * Format a single FlowResult for terminal output
 * Shows checkmark and duration for success, X with error details for failure
 * @param result - The FlowResult to format
 * @returns Formatted result string with ANSI colors
 */
export function formatResult(result: FlowResult): string {
  if (result.skipped) {
    return `${YELLOW}○ ${result.flowName} (skipped)${RESET}`;
  }

  const duration = formatDuration(result.duration);

  if (result.success) {
    return `${GREEN}✓ ${result.flowName} (${duration})${RESET}`;
  }

  const lines: string[] = [];
  lines.push(`${RED}✗ ${result.flowName} (${duration})${RESET}`);

  if (result.error) {
    if (result.error.step !== undefined && result.error.action) {
      const stepLabel = result.error.phase === "setup" ? "Setup step" : "Step";
      lines.push(
        `  ${stepLabel} ${result.error.step}: ${formatAction(result.error.action)}`,
      );
    }
    lines.push(`  Error: ${result.error.message}`);
  }

  return lines.join("\n");
}

/**
 * Format multiple FlowResults into a summary line
 * Shows total, passed, and failed counts
 * @param results - Array of FlowResults to summarize
 * @returns Formatted summary string
 */
export function formatSummary(results: FlowResult[]): string {
  const total = results.length;
  // Bucket by construction rather than by subtraction: a malformed result
  // (success: true alongside skipped: true) is schema-legal, and deriving
  // failed as total - passed - skipped would double-count it into a negative.
  const skipped = results.filter((r) => r.skipped === true).length;
  const passed = results.filter((r) => r.success && r.skipped !== true).length;
  const failed = results.filter((r) => !r.success && r.skipped !== true).length;

  const flowWord = total === 1 ? "flow" : "flows";
  const skippedClause = skipped > 0 ? `, ${skipped} skipped` : "";

  return `${total} ${flowWord}: ${passed} passed, ${failed} failed${skippedClause}`;
}
