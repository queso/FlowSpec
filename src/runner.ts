import { execSync } from "node:child_process";
import type {
  FlowError,
  FlowResult,
  FlowSpec,
  StepAction,
  StepAssertion,
} from "./types";

/**
 * Options for flow execution
 */
export interface RunnerOptions {
  baseUrl?: string;
  timeout?: number;
}

/**
 * Default timeout for assertion retries (in milliseconds)
 */
export const DEFAULT_TIMEOUT = 5000;

/**
 * Interval between retry attempts (in milliseconds)
 */
export const POLL_INTERVAL = 250;

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_BASE_URL = "http://localhost:3456";

/**
 * Escape a string for safe use in shell commands.
 * Uses single quotes and escapes any single quotes within the string.
 * This prevents command injection via backticks, $(), etc.
 */
function shellEscape(str: string): string {
  // Single-quote the entire string and escape any embedded single quotes
  // 'foo' -> 'foo'
  // "it's" -> 'it'"'"'s'
  return `'${str.replace(/'/g, "'\"'\"'")}'`;
}

/**
 * Generate a unique session name for isolation between test runs
 */
function generateSessionName(): string {
  return `flowspec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Execute an agent-browser command and return the output
 */
function execBrowser(command: string, session: string): string {
  try {
    const fullCommand = `agent-browser --session ${session} ${command}`;
    const result = execSync(fullCommand, {
      encoding: "utf-8",
      timeout: 30000,
      shell: process.env.SHELL || "/bin/sh",
    });
    return result;
  } catch (error: unknown) {
    const execError = error as {
      message?: string;
      stderr?: string;
      stdout?: string;
    };
    throw new Error(
      execError.stderr ||
        execError.stdout ||
        execError.message ||
        "Browser command failed",
    );
  }
}

/**
 * Get the current page URL
 */
function getCurrentUrl(session: string): string {
  return execBrowser('eval "window.location.href"', session).trim();
}

/**
 * Get the current page text content
 */
function getPageContent(session: string): string {
  return execBrowser("snapshot", session);
}

/**
 * Get interactive elements with refs
 */
function getInteractiveSnapshot(session: string): string {
  return execBrowser("snapshot -i", session);
}

/**
 * Parse snapshot output to find element ref by text/label
 * Returns the ref (e.g., "@e3") for the matching element
 */
function findElementRef(snapshot: string, targetText: string): string | null {
  const lines = snapshot.split("\n");

  for (const line of lines) {
    // Match lines with refs like: [ref=e3] followed by element info
    // Format examples:
    // - textbox "Email" [ref=e1]
    // - button "Sign In" [ref=e2]
    // - link "Settings" [ref=e5]
    const refMatch = line.match(/\[ref=(\w+)\]/);
    if (!refMatch) continue;

    const ref = `@${refMatch[1]}`;

    // Check if this line contains the target text
    // Could be in quotes as label, or as visible text
    if (line.includes(`"${targetText}"`)) {
      return ref;
    }

    // Also check for partial matches (e.g., "Technical Support" in options)
    const quotedTextMatch = line.match(/"([^"]+)"/g);
    if (quotedTextMatch) {
      for (const quoted of quotedTextMatch) {
        const text = quoted.slice(1, -1); // Remove quotes
        if (text === targetText) {
          return ref;
        }
      }
    }
  }

  return null;
}

/**
 * Find element ref by label (for form fields)
 * Searches for input/textarea/select with the given label
 */
function findFieldRefByLabel(
  snapshot: string,
  labelText: string,
): string | null {
  const lines = snapshot.split("\n");

  for (const line of lines) {
    const refMatch = line.match(/\[ref=(\w+)\]/);
    if (!refMatch) continue;

    // Check for textbox, combobox, or other input types with the label
    const isFormField =
      line.includes("textbox") ||
      line.includes("combobox") ||
      line.includes("textarea") ||
      line.includes("spinbutton");

    if (isFormField && line.includes(`"${labelText}"`)) {
      return `@${refMatch[1]}`;
    }
  }

  return null;
}

/**
 * Execute a visit step
 */
function executeVisit(url: string, baseUrl: string, session: string): void {
  const fullUrl = url.startsWith("http")
    ? url
    : new URL(url, baseUrl).toString();
  execBrowser(`open ${shellEscape(fullUrl)}`, session);
}

/**
 * Execute a click step
 */
function executeClick(targetText: string, session: string): void {
  const snapshot = getInteractiveSnapshot(session);
  const ref = findElementRef(snapshot, targetText);

  if (!ref) {
    const currentUrl = getCurrentUrl(session);
    throw new Error(
      `Could not find element with text "${targetText}" on ${currentUrl}`,
    );
  }

  execBrowser(`click ${ref}`, session);
}

/**
 * Execute a fill step
 */
function executeFill(fields: Record<string, string>, session: string): void {
  const snapshot = getInteractiveSnapshot(session);

  for (const [label, value] of Object.entries(fields)) {
    const ref = findFieldRefByLabel(snapshot, label);

    if (!ref) {
      const currentUrl = getCurrentUrl(session);
      throw new Error(
        `Could not find field with label "${label}" on ${currentUrl}`,
      );
    }

    // Use fill to clear and set value
    execBrowser(`fill ${ref} ${shellEscape(value)}`, session);
  }
}

/**
 * Execute a select step
 */
function executeSelect(
  selections: Record<string, string>,
  session: string,
): void {
  const snapshot = getInteractiveSnapshot(session);

  for (const [label, option] of Object.entries(selections)) {
    const ref = findFieldRefByLabel(snapshot, label);

    if (!ref) {
      const currentUrl = getCurrentUrl(session);
      throw new Error(
        `Could not find select field with label "${label}" on ${currentUrl}`,
      );
    }

    execBrowser(`select ${ref} ${shellEscape(option)}`, session);
  }
}

/**
 * Execute a single step
 */
function executeStep(step: StepAction, baseUrl: string, session: string): void {
  if ("visit" in step) {
    executeVisit(step.visit, baseUrl, session);
  } else if ("click" in step) {
    executeClick(step.click, session);
  } else if ("fill" in step) {
    executeFill(step.fill, session);
  } else if ("select" in step) {
    executeSelect(step.select, session);
  }
}

/**
 * Check a URL assertion
 */
function assertUrl(
  expected: string,
  session: string,
): { passed: boolean; actual: string } {
  const actual = getCurrentUrl(session);
  const passed = actual.endsWith(expected) || actual.includes(expected);
  return { passed, actual };
}

/**
 * Check a visible assertion
 */
function assertVisible(
  text: string,
  session: string,
): { passed: boolean; content: string } {
  const content = getPageContent(session);
  const passed = content.includes(text);
  return { passed, content };
}

/**
 * Check a matches (regex) assertion
 */
function assertMatches(
  pattern: string,
  session: string,
): { passed: boolean; content: string } {
  const content = getPageContent(session);
  const regex = new RegExp(pattern);
  const passed = regex.test(content);
  return { passed, content };
}

/**
 * Check a not_visible assertion
 */
function assertNotVisible(
  text: string,
  session: string,
): { passed: boolean; content: string } {
  const content = getPageContent(session);
  const passed = !content.includes(text);
  return { passed, content };
}

/**
 * Check a single assertion once (synchronous single-check)
 * Returns error if assertion fails, undefined if it passes
 */
function checkAssertion(
  assertion: StepAssertion,
  session: string,
): FlowError | undefined {
  if ("url" in assertion) {
    const result = assertUrl(assertion.url, session);
    if (!result.passed) {
      return {
        message: `URL assertion failed: expected "${assertion.url}" but got "${result.actual}"`,
        assertion,
      };
    }
  } else if ("visible" in assertion) {
    const result = assertVisible(assertion.visible, session);
    if (!result.passed) {
      return {
        message: `Visible assertion failed: text "${assertion.visible}" not found on page`,
        assertion,
      };
    }
  } else if ("matches" in assertion) {
    try {
      const result = assertMatches(assertion.matches, session);
      if (!result.passed) {
        return {
          message: `Matches assertion failed: pattern "${assertion.matches}" did not match page content`,
          assertion,
        };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        message: `Matches assertion failed: invalid pattern "${assertion.matches}" - ${message}`,
        assertion,
      };
    }
  } else if ("not_visible" in assertion) {
    const result = assertNotVisible(assertion.not_visible, session);
    if (!result.passed) {
      return {
        message: `Not visible assertion failed: text "${assertion.not_visible}" was found on page`,
        assertion,
      };
    }
  }

  return undefined;
}

/**
 * Execute a single assertion with retry/polling
 * Wraps checkAssertion in a poll loop until pass or timeout
 * Returns error if assertion fails after all retries, undefined if it passes
 */
async function executeAssertion(
  assertion: StepAssertion,
  session: string,
  timeout: number,
): Promise<FlowError | undefined> {
  // First check: if it passes, return immediately (zero overhead)
  let lastError = checkAssertion(assertion, session);
  if (!lastError) {
    return undefined;
  }

  // If timeout is 0, no retry - return the error immediately
  if (timeout <= 0) {
    return lastError;
  }

  // Calculate deadline for retry loop
  const deadline = Date.now() + timeout;

  // Poll loop: sleep, then re-check until pass or deadline
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL);

    // Re-check assertion (re-fetches page state from browser)
    lastError = checkAssertion(assertion, session);
    if (!lastError) {
      return undefined;
    }
  }

  // Timeout reached: return the last error
  return lastError;
}

/**
 * Close a browser session
 */
function closeBrowserSession(session: string): void {
  try {
    execBrowser("close", session);
  } catch {
    // Ignore errors when closing - session may already be closed
  }
}

/**
 * Execute a flow specification and return the result
 * @param flow - The FlowSpec to execute
 * @param options - Optional runner configuration
 * @returns Promise resolving to the FlowResult
 */
export async function runFlow(
  flow: FlowSpec,
  options?: RunnerOptions,
): Promise<FlowResult> {
  const startTime = Date.now();
  const baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL;
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
  const session = generateSessionName();

  try {
    // Execute all steps
    for (let stepIndex = 0; stepIndex < flow.steps.length; stepIndex++) {
      const step = flow.steps[stepIndex];

      try {
        executeStep(step, baseUrl, session);
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          success: false,
          flowName: flow.name,
          duration: Date.now() - startTime,
          error: {
            message: errorMessage,
            step: stepIndex,
            action: step,
          },
        };
      }
    }

    // Execute all assertions with retry/polling
    for (const assertion of flow.expect) {
      const assertionError = await executeAssertion(
        assertion,
        session,
        timeout,
      );
      if (assertionError) {
        return {
          success: false,
          flowName: flow.name,
          duration: Date.now() - startTime,
          error: assertionError,
        };
      }
    }

    return {
      success: true,
      flowName: flow.name,
      duration: Date.now() - startTime,
    };
  } finally {
    // Always close the browser session when done
    closeBrowserSession(session);
  }
}
