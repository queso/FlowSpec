/**
 * Retryable file-existence and file-content matchers. Surface-agnostic
 * (callers pass an already-resolved absolute path — path resolution against
 * a flow's working directory is a different item's job) so the CLI
 * assertion dispatcher and, later, the Conduit surface can reuse these
 * unchanged.
 *
 * Both matchers follow executeAssertion's retry shape (src/runner.ts:599):
 * a zero-overhead first check, then poll on POLL_INTERVAL until a deadline,
 * returning the last failure. A timeout of 0 or absent means exactly one
 * evaluation — no polling loop is entered at all.
 */

import { access, readFile } from "node:fs/promises";
import { type MatchFailure, matchContains } from "./matchers.js";
import { POLL_INTERVAL } from "./runner.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `check` once immediately (zero overhead); if it fails and `timeout` is
 * a positive number, keep re-running it every POLL_INTERVAL until `timeout`
 * elapses, returning the last failure. A file's presence/content can change
 * between polls (an async writer still flushing), so `check` re-reads from
 * disk on every call rather than being memoized.
 */
async function pollUntilPass(
  check: () => Promise<MatchFailure | undefined>,
  timeout: number | undefined,
): Promise<MatchFailure | undefined> {
  const firstResult = await check();
  if (!firstResult) {
    return undefined;
  }

  if (!timeout || timeout <= 0) {
    return firstResult;
  }

  const deadline = Date.now() + timeout;
  let lastResult: MatchFailure | undefined = firstResult;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL);
    lastResult = await check();
    if (!lastResult) {
      return undefined;
    }
  }

  return lastResult;
}

async function checkFileExists(
  absolutePath: string,
): Promise<MatchFailure | undefined> {
  try {
    await access(absolutePath);
    return undefined;
  } catch {
    return {
      message: `Expected file to exist at ${absolutePath} but it was not found`,
      expected: absolutePath,
    };
  }
}

async function checkFileContains(
  absolutePath: string,
  expected: string,
): Promise<MatchFailure | undefined> {
  let content: string;
  try {
    content = await readFile(absolutePath, "utf-8");
  } catch {
    return {
      message: `Expected file at ${absolutePath} to contain "${expected}" but the file was not found`,
      expected,
    };
  }

  const failure = matchContains(content, expected);
  if (!failure) {
    return undefined;
  }

  return {
    message: `File ${absolutePath}: ${failure.message}`,
    expected: failure.expected,
    actual: failure.actual,
  };
}

/**
 * Passes once `absolutePath` exists on disk. On failure, the message names
 * the absolute path.
 */
export async function fileExists(
  absolutePath: string,
  timeout?: number,
): Promise<MatchFailure | undefined> {
  return pollUntilPass(() => checkFileExists(absolutePath), timeout);
}

/**
 * Passes once the file at `absolutePath` exists and its UTF-8 content
 * contains `expected` as a substring. On failure, the message names both the
 * absolute path and the expected text.
 */
export async function fileContains(
  absolutePath: string,
  expected: string,
  timeout?: number,
): Promise<MatchFailure | undefined> {
  return pollUntilPass(
    () => checkFileContains(absolutePath, expected),
    timeout,
  );
}
