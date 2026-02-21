import type { FlowError, FlowResult, StepAction } from "./types.js";

// ANSI color codes
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
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
    parts.push(`Step ${error.step}: ${formatAction(error.action)}`);
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
  const duration = formatDuration(result.duration);

  if (result.success) {
    return `${GREEN}✓ ${result.flowName} (${duration})${RESET}`;
  }

  const lines: string[] = [];
  lines.push(`${RED}✗ ${result.flowName} (${duration})${RESET}`);

  if (result.error) {
    if (result.error.step !== undefined && result.error.action) {
      lines.push(
        `  Step ${result.error.step}: ${formatAction(result.error.action)}`,
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
  const passed = results.filter((r) => r.success).length;
  const failed = total - passed;

  const flowWord = total === 1 ? "flow" : "flows";

  return `${total} ${flowWord}: ${passed} passed, ${failed} failed`;
}
