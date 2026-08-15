import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  FlowError,
  FlowResult,
  FlowSpec,
  FlowStep,
  StepAction,
  StepAssertion,
} from "./types.js";

// Declare minimal Bun types for TypeScript when running in Bun runtime
declare global {
  // eslint-disable-next-line no-var
  var Bun:
    | {
        spawn: (
          cmd: string[],
          options?: {
            stdout?: "pipe" | "inherit" | "ignore";
            stderr?: "pipe" | "inherit" | "ignore";
            stdin?: "pipe" | "inherit" | "ignore";
          },
        ) => {
          stdout: ReadableStream;
          stderr: ReadableStream;
          exited: Promise<number>;
        };
      }
    | undefined;
}

/**
 * Options for flow execution
 */
export interface RunnerOptions {
  baseUrl?: string;
  timeout?: number;
  setup?: FlowStep[];
  headers?: Record<string, string>;
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
 * Get the path to the agent-browser binary
 */
function getAgentBrowserPath(): string {
  // Try to find agent-browser in node_modules/.bin
  // This works whether we're running from src/ or from dist/
  const currentFile = import.meta.url;
  const currentDir = dirname(fileURLToPath(currentFile));

  // From src/ it's ../node_modules/.bin/agent-browser
  // From dist/ it's ../node_modules/.bin/agent-browser
  const binPath = join(
    currentDir,
    "..",
    "node_modules",
    ".bin",
    "agent-browser",
  );

  // If that doesn't work, fall back to npx
  return binPath;
}

/**
 * Execute a command using Bun's native spawn or Node's execFileSync
 * Bun.spawn is used when available as it works better with concurrent I/O
 */
async function execCommand(
  binPath: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Check if Bun.spawn is available (running in Bun runtime)
  // Use globalThis to avoid ReferenceError under Node.js where Bun is undeclared
  const BunRuntime = globalThis.Bun;
  if (BunRuntime?.spawn) {
    const proc = BunRuntime.spawn([binPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { stdout, stderr, exitCode };
  }

  // Fall back to Node's execFileSync
  const { execFileSync } = await import("node:child_process");
  try {
    const stdout = execFileSync(binPath, args, {
      encoding: "utf-8",
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (error: unknown) {
    const execError = error as {
      stderr?: Buffer | string;
      stdout?: Buffer | string;
      status?: number;
    };

    const stderr =
      typeof execError.stderr === "string"
        ? execError.stderr
        : execError.stderr?.toString() || "";
    const stdout =
      typeof execError.stdout === "string"
        ? execError.stdout
        : execError.stdout?.toString() || "";

    return { stdout, stderr, exitCode: execError.status || 1 };
  }
}

/**
 * Execute an agent-browser command and return the output
 */
async function execBrowser(command: string, session: string): Promise<string> {
  const browserPath = getAgentBrowserPath();

  // Parse command into args array - handle quoted strings
  const args = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  // Remove quotes from args
  const cleanArgs = args.map((arg) => arg.replace(/^["']|["']$/g, ""));

  // Build full args array
  const fullArgs = ["--session", session, ...cleanArgs];

  const result = await execCommand(browserPath, fullArgs);

  if (result.exitCode !== 0) {
    // Include both stderr and stdout in error for debugging
    const errorMessage =
      result.stderr || result.stdout || "Browser command failed";
    throw new Error(errorMessage);
  }

  return result.stdout;
}

/**
 * Get the current page URL
 */
async function getCurrentUrl(session: string): Promise<string> {
  const result = await execBrowser('eval "window.location.href"', session);
  return result.trim();
}

/**
 * Get the current page text content
 */
async function getPageContent(session: string): Promise<string> {
  return execBrowser("snapshot", session);
}

/**
 * Get interactive elements with refs
 */
async function getInteractiveSnapshot(session: string): Promise<string> {
  return execBrowser("snapshot", session);
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
async function executeVisit(
  url: string,
  baseUrl: string,
  session: string,
): Promise<void> {
  const fullUrl = url.startsWith("http")
    ? url
    : new URL(url, baseUrl).toString();
  await execBrowser(`open ${shellEscape(fullUrl)}`, session);
}

/**
 * Execute a click step
 */
async function executeClick(
  targetText: string,
  session: string,
): Promise<void> {
  const snapshot = await getInteractiveSnapshot(session);
  const ref = findElementRef(snapshot, targetText);

  if (!ref) {
    const currentUrl = await getCurrentUrl(session);
    throw new Error(
      `Could not find element with text "${targetText}" on ${currentUrl}`,
    );
  }

  await execBrowser(`click ${ref}`, session);
}

/**
 * Execute a fill step
 */
async function executeFill(
  fields: Record<string, string>,
  session: string,
): Promise<void> {
  const snapshot = await getInteractiveSnapshot(session);

  for (const [label, value] of Object.entries(fields)) {
    const ref = findFieldRefByLabel(snapshot, label);

    if (!ref) {
      const currentUrl = await getCurrentUrl(session);
      throw new Error(
        `Could not find field with label "${label}" on ${currentUrl}`,
      );
    }

    // Use fill to clear and set value
    await execBrowser(`fill ${ref} ${shellEscape(value)}`, session);
  }
}

/**
 * Execute a select step
 */
async function executeSelect(
  selections: Record<string, string>,
  session: string,
): Promise<void> {
  const snapshot = await getInteractiveSnapshot(session);

  for (const [label, option] of Object.entries(selections)) {
    const ref = findFieldRefByLabel(snapshot, label);

    if (!ref) {
      const currentUrl = await getCurrentUrl(session);
      throw new Error(
        `Could not find select field with label "${label}" on ${currentUrl}`,
      );
    }

    await execBrowser(`select ${ref} ${shellEscape(option)}`, session);
  }
}

/**
 * Check if text is visible on the page
 * Returns undefined if found, or an error message if not found
 */
async function checkTextVisible(
  text: string,
  session: string,
): Promise<string | undefined> {
  const content = await getPageContent(session);
  if (content.includes(text)) {
    return undefined;
  }
  const currentUrl = await getCurrentUrl(session);
  return `Text "${text}" not found on ${currentUrl}`;
}

/**
 * Execute a wait_for step with retry/polling
 * Waits until the specified text appears on the page
 */
async function executeWaitFor(
  text: string,
  session: string,
  timeout: number,
): Promise<void> {
  // First check: if text is visible, return immediately
  let lastError = await checkTextVisible(text, session);
  if (!lastError) {
    return;
  }

  // If timeout is 0, fail immediately
  if (timeout <= 0) {
    throw new Error(lastError);
  }

  // Calculate deadline for retry loop
  const deadline = Date.now() + timeout;

  // Poll loop: sleep, then re-check until found or deadline
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL);

    lastError = await checkTextVisible(text, session);
    if (!lastError) {
      return;
    }
  }

  // Timeout reached: throw the last error
  throw new Error(
    `Timeout waiting for text "${text}" to appear (waited ${timeout}ms)`,
  );
}

/**
 * Execute a single step
 * Returns a Promise to handle async steps like wait_for
 */
async function executeStep(
  step: StepAction,
  baseUrl: string,
  session: string,
  timeout: number,
): Promise<void> {
  if ("visit" in step) {
    await executeVisit(step.visit, baseUrl, session);
  } else if ("click" in step) {
    await executeClick(step.click, session);
  } else if ("fill" in step) {
    await executeFill(step.fill, session);
  } else if ("select" in step) {
    await executeSelect(step.select, session);
  } else if ("wait_for" in step) {
    await executeWaitFor(step.wait_for, session, timeout);
  }
}

/**
 * Check a URL assertion
 */
async function assertUrl(
  expected: string,
  session: string,
): Promise<{ passed: boolean; actual: string }> {
  const actual = await getCurrentUrl(session);
  const passed = actual.endsWith(expected) || actual.includes(expected);
  return { passed, actual };
}

/**
 * Check a visible assertion
 */
async function assertVisible(
  text: string,
  session: string,
): Promise<{ passed: boolean; content: string }> {
  const content = await getPageContent(session);
  const passed = content.includes(text);
  return { passed, content };
}

/**
 * Check a matches (regex) assertion
 */
async function assertMatches(
  pattern: string,
  session: string,
): Promise<{ passed: boolean; content: string }> {
  const content = await getPageContent(session);
  const regex = new RegExp(pattern);
  const passed = regex.test(content);
  return { passed, content };
}

/**
 * Check a not_visible assertion
 */
async function assertNotVisible(
  text: string,
  session: string,
): Promise<{ passed: boolean; content: string }> {
  const content = await getPageContent(session);
  const passed = !content.includes(text);
  return { passed, content };
}

/**
 * Check a single assertion once (synchronous single-check)
 * Returns error if assertion fails, undefined if it passes
 */
async function checkAssertion(
  assertion: StepAssertion,
  session: string,
): Promise<FlowError | undefined> {
  if ("url" in assertion) {
    const result = await assertUrl(assertion.url, session);
    if (!result.passed) {
      return {
        message: `URL assertion failed: expected "${assertion.url}" but got "${result.actual}"`,
        assertion,
      };
    }
  } else if ("visible" in assertion) {
    const result = await assertVisible(assertion.visible, session);
    if (!result.passed) {
      return {
        message: `Visible assertion failed: text "${assertion.visible}" not found on page`,
        assertion,
      };
    }
  } else if ("matches" in assertion) {
    try {
      const result = await assertMatches(assertion.matches, session);
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
    const result = await assertNotVisible(assertion.not_visible, session);
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
  let lastError = await checkAssertion(assertion, session);
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
    lastError = await checkAssertion(assertion, session);
    if (!lastError) {
      return undefined;
    }
  }

  // Timeout reached: return the last error
  return lastError;
}

/**
 * Apply extra HTTP headers to the browser session.
 *
 * The session persists across agent-browser invocations, so setting them once
 * up front covers every request the flow makes afterwards. Read-only access to
 * the headers object — it may be shared/aliased by the caller.
 */
async function applyHeaders(
  headers: Record<string, string>,
  session: string,
): Promise<void> {
  await execBrowser(
    `set headers ${shellEscape(JSON.stringify(headers))}`,
    session,
  );
}

/**
 * Close a browser session
 */
async function closeBrowserSession(session: string): Promise<void> {
  try {
    await execBrowser("close", session);
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
    // Apply configured headers before anything else touches the browser, so
    // setup steps and flow steps alike make their requests with the headers
    // already in place. With no headers configured (undefined or empty), no
    // browser command is issued at all — flows without headers pay nothing.
    const headers = options?.headers;
    if (headers && Object.keys(headers).length > 0) {
      try {
        await applyHeaders(headers, session);
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        // No step/action: nothing step-like failed here, and the message is
        // self-describing.
        return {
          success: false,
          flowName: flow.name,
          duration: Date.now() - startTime,
          error: {
            message: `Failed to apply headers: ${errorMessage}`,
            phase: "headers",
          },
        };
      }
    }

    // Resolve the effective setup: a flow-level setup block replaces the
    // config/CLI-level one entirely (no merging). An empty array is not
    // nullish, so an explicit `setup: []` on the flow opts out even when
    // options.setup is supplied.
    const setupSteps = flow.setup ?? options?.setup;

    // Execute setup steps (if any) in the same browser session, before the
    // flow's own steps, so state established during setup (e.g. an auth
    // cookie) is observed by everything that follows. Read-only iteration —
    // the setup array may be shared/aliased by the caller and must not be
    // mutated.
    if (setupSteps && setupSteps.length > 0) {
      for (let setupIndex = 0; setupIndex < setupSteps.length; setupIndex++) {
        const step = setupSteps[setupIndex];

        try {
          await executeStep(step, baseUrl, session, timeout);
        } catch (error: unknown) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          return {
            success: false,
            flowName: flow.name,
            duration: Date.now() - startTime,
            error: {
              message: errorMessage,
              phase: "setup",
              step: setupIndex,
              action: step,
            },
          };
        }
      }
    }

    // Execute all steps
    for (let stepIndex = 0; stepIndex < flow.steps.length; stepIndex++) {
      const step = flow.steps[stepIndex];

      try {
        await executeStep(step, baseUrl, session, timeout);
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
    await closeBrowserSession(session);
  }
}
