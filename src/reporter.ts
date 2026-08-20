import type { CliStep, FlowError, FlowResult, StepAction } from "./types.js";

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
 * Format a StepAction (web) or CliStep (CLI) into a human-readable string.
 *
 * CLI action rendering here is intentionally minimal — a short "run ..."
 * label, not a full CLI-aware report. The full CLI failure report (exit
 * code, stdout/stderr excerpts, kept workdir) is a separate item's scope;
 * this only keeps a CLI action from silently falling through to "unknown
 * action" now that FlowErrorSchema.action accepts one.
 */
function formatAction(action: StepAction | CliStep): string {
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
  if ("run" in action) {
    const command = Array.isArray(action.run)
      ? action.run.join(" ")
      : action.run;
    return `run "${command}"`;
  }
  return "unknown action";
}

/**
 * The indent every continuation line of the failure report carries. Both
 * entry points below indent by this much, so a multi-line field's own
 * embedded newlines have to be re-indented to the same depth.
 */
const REPORT_INDENT = "  ";

/**
 * Re-indent every line of a possibly multi-line value so it lines up under
 * its label. Without this, only the FIRST physical line of a captured
 * stdout/stderr renders indented and the rest run flush against the left
 * margin, visually escaping the failure block they belong to.
 */
function indentLines(text: string, indent: string): string {
  return text.split("\n").join(`\n${indent}`);
}

/**
 * Build the CLI-specific failure lines (exit code, bounded stdout/stderr
 * excerpts, and — when present — the kept working directory) shared by
 * formatError and formatResult, so the two entry points can never drift out
 * of sync with each other.
 *
 * The two groups gate INDEPENDENTLY, because they answer to different
 * fields:
 *
 * - exitCode/stdout/stderr gate on `error.exitCode !== undefined`: that
 *   field's presence alone signals a completed CLI process (a web failure
 *   never sets it) — independent of whether `step`/`action` are also
 *   present, since an assertion failure doesn't carry a step index the way
 *   an action-step failure does. stdout/stderr are rendered as-is apart
 *   from re-indentation: they're already bounded/truncated upstream
 *   (src/matchers.ts's boundedExcerpt, applied by both the assertion and
 *   step-failure paths), so a truncation marker baked in there is preserved
 *   verbatim, never re-cut here.
 *
 * - The workdir line gates on `error.workdir !== undefined` ALONE. A spawn
 *   failure (command not found) never produces an exit code, but its
 *   working directory is genuinely kept on disk (dispose(false) still ran),
 *   so folding it into the exitCode gate would mean the kept directory's
 *   path is never printed and the user can't find it. A configured cwd (the
 *   user's own directory) never sets `workdir`, so nothing "working
 *   directory"-shaped is printed for that case either way.
 */
function formatCliFailureLines(error: FlowError): string[] {
  const lines: string[] = [];

  if (error.exitCode !== undefined) {
    lines.push(
      `Exit code: ${error.exitCode}`,
      `stdout: ${indentLines(error.stdout ?? "", REPORT_INDENT)}`,
      `stderr: ${indentLines(error.stderr ?? "", REPORT_INDENT)}`,
    );
  }

  if (error.workdir !== undefined) {
    lines.push(`Kept working directory: ${error.workdir}`);
  }

  return lines;
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

  parts.push(`Error: ${indentLines(error.message, REPORT_INDENT)}`);
  parts.push(...formatCliFailureLines(error));

  return parts.join(`\n${REPORT_INDENT}`);
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
        `${REPORT_INDENT}${stepLabel} ${result.error.step}: ${formatAction(result.error.action)}`,
      );
    }
    lines.push(
      `${REPORT_INDENT}Error: ${indentLines(result.error.message, REPORT_INDENT)}`,
    );
    for (const cliLine of formatCliFailureLines(result.error)) {
      lines.push(`${REPORT_INDENT}${cliLine}`);
    }
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
