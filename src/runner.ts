import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { runCliFlow } from "./cli-runner.js";
import type {
  FlowError,
  FlowResult,
  FlowSpec,
  FlowStep,
  StepAction,
  StepAssertion,
} from "./types.js";
import { asCliFlow, asWebFlow } from "./types.js";

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
  /**
   * Assertion-retry budget, in milliseconds: how long an assertion keeps
   * being re-checked before it fails. Never a process deadline — a CLI run
   * step's kill deadline is `stepTimeout`.
   */
  timeout?: number;
  /**
   * CLI-surface process-kill deadline for a single `run` step, in
   * milliseconds. Web flows ignore this. Absent falls back to
   * DEFAULT_STEP_TIMEOUT (src/config.ts), not to `timeout`.
   */
  stepTimeout?: number;
  setup?: FlowStep[];
  headers?: Record<string, string>;
  /**
   * How far the configured headers travel. Defaults to "origin": headers go
   * only to baseUrl's origin, so a bypass token never rides along to a CDN,
   * an analytics pixel, or any other third party the page happens to touch.
   * "all" is the deliberate opt-out — context-wide, every request, every host.
   */
  headersScope?: "origin" | "all";
  /** CLI-surface working-directory override. Web flows ignore this. */
  cwd?: string;
  /** CLI-surface per-stream capture ceiling, in bytes. Web flows ignore this. */
  captureLimit?: number;
}

/**
 * Headers scoped to a single origin: the origin they may be sent to, and the
 * JSON document agent-browser's `--headers` option expects.
 */
interface ScopedHeaders {
  origin: string;
  json: string;
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
 * Generate a unique session name for isolation between test runs
 */
function generateSessionName(): string {
  return `flowspec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Get the path to the agent-browser binary.
 *
 * Resolves through Node module resolution rather than a hardcoded
 * `<flowspec>/node_modules/.bin` path, because that layout only exists
 * under nested installs (pnpm, or flowspec's own repo). Hoisting package
 * managers (bun, npm) place agent-browser at the consumer root, where the
 * old path pointed at nothing and every flow died with "Browser command
 * failed" (#15).
 *
 * Preference order: the `.bin` shim beside the resolved package (same
 * spawn semantics as before), then the package's own bin script, then a
 * bare `agent-browser` for PATH lookup.
 *
 * @param fromUrl module URL to resolve from — overridable for tests
 */
export function getAgentBrowserPath(fromUrl: string = import.meta.url): string {
  try {
    const require = createRequire(fromUrl);
    const pkgJsonPath = require.resolve("agent-browser/package.json");
    const pkgDir = dirname(pkgJsonPath);

    // The .bin shim lives in the node_modules that contains the package.
    const shimPath = join(dirname(pkgDir), ".bin", "agent-browser");
    if (existsSync(shimPath)) return shimPath;

    const pkg = require(pkgJsonPath) as {
      bin?: string | Record<string, string>;
    };
    const bin =
      typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["agent-browser"];
    if (bin) {
      const binPath = join(pkgDir, bin);
      if (existsSync(binPath)) return binPath;
    }
  } catch {
    // Not resolvable as a module — fall through to PATH lookup.
  }

  return "agent-browser";
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
 * Execute an agent-browser command and return the output.
 *
 * Takes the command as an argv array — one element per argument — which is
 * handed straight to spawn. No shell is involved anywhere in this path, so
 * arguments need no quoting or escaping: whatever bytes a caller puts in an
 * element are exactly the bytes agent-browser receives, quotes, spaces,
 * backticks and `$(...)` included.
 */
async function execBrowserArgs(
  args: string[],
  session: string,
): Promise<string> {
  const browserPath = getAgentBrowserPath();

  const result = await execCommand(browserPath, [
    "--session",
    session,
    ...args,
  ]);

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
  const result = await execBrowserArgs(
    ["eval", "window.location.href"],
    session,
  );
  return result.trim();
}

/**
 * Get the current page text content
 */
async function getPageContent(session: string): Promise<string> {
  return execBrowserArgs(["snapshot"], session);
}

/**
 * Get interactive elements with refs
 */
async function getInteractiveSnapshot(session: string): Promise<string> {
  return execBrowserArgs(["snapshot"], session);
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
 * Build the `--headers` arguments for a navigation, if this navigation is the
 * one allowed to carry them.
 *
 * agent-browser's global `--headers <json>` option is consumed only by the
 * `open` command, and it scopes the headers to the OPENED url's host — it
 * registers a request-route interception for that host rather than setting
 * them context-wide. Passing it on an open to a different origin would scope
 * the token to *that* origin, which is the leak this whole path exists to
 * avoid, so a non-matching navigation gets no header arguments at all.
 *
 * Two consequences worth knowing, both verified against agent-browser:
 *  - The scoping persists for the rest of the session, so re-passing it on
 *    every matching navigation is idempotent, not repeated work undone.
 *  - agent-browser matches on host, ignoring scheme. Requests to the same
 *    host over a different scheme are therefore also covered once the route
 *    is registered; the origin check here is the stricter of the two.
 */
function visitHeaderArgs(
  fullUrl: string,
  scopedHeaders: ScopedHeaders | undefined,
): string[] {
  if (!scopedHeaders) {
    return [];
  }

  let origin: string;
  try {
    origin = new URL(fullUrl).origin;
  } catch {
    // Not a URL we can reason about — let the open itself report the problem
    // rather than attaching a token to something unparseable.
    return [];
  }

  return origin === scopedHeaders.origin
    ? ["--headers", scopedHeaders.json]
    : [];
}

/**
 * Execute a visit step
 */
async function executeVisit(
  url: string,
  baseUrl: string,
  session: string,
  scopedHeaders?: ScopedHeaders,
): Promise<void> {
  const fullUrl = url.startsWith("http")
    ? url
    : new URL(url, baseUrl).toString();
  await execBrowserArgs(
    [...visitHeaderArgs(fullUrl, scopedHeaders), "open", fullUrl],
    session,
  );
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

  await execBrowserArgs(["click", ref], session);
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
    await execBrowserArgs(["fill", ref, value], session);
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

    await execBrowserArgs(["select", ref, option], session);
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
  scopedHeaders?: ScopedHeaders,
): Promise<void> {
  if ("visit" in step) {
    await executeVisit(step.visit, baseUrl, session, scopedHeaders);
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
 * RFC 7230 field-name grammar: a header name is one or more "token"
 * characters. Anything else (a space, a colon, a non-ASCII byte) is not a
 * header name.
 */
const HEADER_NAME_REGEX = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Bytes that can never appear in a header value: NUL, and the CR/LF pair that
 * would let a value inject a second header or terminate the head section.
 */
const HEADER_VALUE_FORBIDDEN_REGEX = /[\0\r\n]/;

/**
 * Reject malformed headers before any browser command runs.
 *
 * This is not belt-and-braces: the two scopes fail very differently without
 * it. Context-wide headers go through Playwright's setExtraHTTPHeaders, which
 * rejects a bad name promptly. Origin-scoped headers are applied by a request
 * route that rewrites headers mid-flight, and a bad name makes that route
 * throw *inside* the interception handler — the request is then never
 * fulfilled and the navigation hangs indefinitely rather than failing. A flow
 * that hangs tells the user nothing; a checked, named error tells them
 * exactly which header to fix.
 *
 * Read-only access to the headers object — it may be shared by the caller.
 */
function validateHeaders(headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME_REGEX.test(name)) {
      throw new Error(
        `invalid header name ${JSON.stringify(name)} - HTTP header names may only contain letters, digits and !#$%&'*+-.^_\`|~`,
      );
    }

    if (HEADER_VALUE_FORBIDDEN_REGEX.test(value)) {
      throw new Error(
        `invalid value for header ${JSON.stringify(name)} - HTTP header values may not contain NUL, carriage return or line feed`,
      );
    }
  }
}

/**
 * Apply extra HTTP headers context-wide (headersScope: "all").
 *
 * The session persists across agent-browser invocations, so setting them once
 * up front covers every request the flow makes afterwards — including
 * requests to origins that are not the one under test, which is exactly why
 * this is the opt-in path and not the default. Read-only access to the
 * headers object — it may be shared/aliased by the caller.
 */
async function applyHeaders(
  headers: Record<string, string>,
  session: string,
): Promise<void> {
  await execBrowserArgs(["set", "headers", JSON.stringify(headers)], session);
}

/**
 * Close a browser session
 */
async function closeBrowserSession(session: string): Promise<void> {
  try {
    await execBrowserArgs(["close"], session);
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
  // Surface dispatch: the ABSOLUTE FIRST thing runFlow does, before a
  // browser session name is even generated, before headers are validated —
  // a CLI flow must never resolve or launch agent-browser. runCliFlow owns
  // the whole CLI lifecycle (working directory, steps, assertions); the
  // web path below is completely untouched for surface: "web" (or absent).
  if (flow.surface === "cli") {
    // The one place the surface is decided is the one place the flow is
    // narrowed to its CLI shape (see asCliFlow) — the CLI runner then works
    // in CliStep/CliAssertion terms throughout, with no per-use casts.
    return runCliFlow(asCliFlow(flow), {
      cwd: options?.cwd,
      timeout: options?.timeout,
      stepTimeout: options?.stepTimeout,
      captureLimit: options?.captureLimit,
    });
  }

  // Everything past the dispatch is the web path, so the flow is narrowed to
  // the web vocabulary once, here, rather than at each step/assertion use.
  const webFlow = asWebFlow(flow);

  const startTime = Date.now();
  const baseUrl = options?.baseUrl ?? DEFAULT_BASE_URL;
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
  const session = generateSessionName();

  // Headers scoped to baseUrl's origin, attached to each matching navigation
  // (see visitHeaderArgs). Stays undefined for scope "all" and for flows with
  // no headers at all.
  let scopedHeaders: ScopedHeaders | undefined;

  try {
    // Apply configured headers before anything else touches the browser, so
    // setup steps and flow steps alike make their requests with the headers
    // already in place. With no headers configured (undefined or empty), no
    // browser command is issued at all — flows without headers pay nothing.
    const headers = options?.headers;
    if (headers && Object.keys(headers).length > 0) {
      try {
        validateHeaders(headers);

        // "origin" is the default: a token configured for the deployment
        // under test must not be handed to every third-party host the page
        // touches. "all" restores context-wide headers for callers who
        // genuinely need them.
        if ((options?.headersScope ?? "origin") === "all") {
          await applyHeaders(headers, session);
        } else {
          scopedHeaders = {
            origin: new URL(baseUrl).origin,
            json: JSON.stringify(headers),
          };
        }
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
    const setupSteps = webFlow.setup ?? options?.setup;

    // Execute setup steps (if any) in the same browser session, before the
    // flow's own steps, so state established during setup (e.g. an auth
    // cookie) is observed by everything that follows. Read-only iteration —
    // the setup array may be shared/aliased by the caller and must not be
    // mutated.
    if (setupSteps && setupSteps.length > 0) {
      for (let setupIndex = 0; setupIndex < setupSteps.length; setupIndex++) {
        const step = setupSteps[setupIndex];

        try {
          await executeStep(step, baseUrl, session, timeout, scopedHeaders);
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
    for (let stepIndex = 0; stepIndex < webFlow.steps.length; stepIndex++) {
      const step = webFlow.steps[stepIndex];

      try {
        await executeStep(step, baseUrl, session, timeout, scopedHeaders);
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
    for (const assertion of webFlow.expect) {
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
