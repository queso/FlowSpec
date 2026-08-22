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

import { access, open } from "node:fs/promises";
import { DEFAULT_CAPTURE_LIMIT } from "./exec.js";
import { type MatchFailure, matchContains } from "./matchers.js";
import { POLL_INTERVAL } from "./runner.js";

/**
 * Upper bound on how much of a file fileContains reads, reusing the same
 * per-stream cap src/exec.ts applies to captured stdout/stderr rather than
 * introducing a second, unrelated number. This matters because the check
 * re-reads from disk on EVERY poll tick (once per POLL_INTERVAL for the
 * whole timeout window): an unbounded readFile would pull an arbitrarily
 * large file fully into memory, repeatedly.
 */
const FILE_READ_LIMIT = DEFAULT_CAPTURE_LIMIT;

/**
 * Read at most FILE_READ_LIMIT bytes from the head of a file. Allocates
 * against the file's actual size when it is smaller than the cap, so the
 * common small-file case doesn't pay for the cap.
 */
async function readBoundedFile(absolutePath: string): Promise<string> {
  const handle = await open(absolutePath, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(Number(size), FILE_READ_LIMIT);
    if (length <= 0) {
      return "";
    }
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).toString("utf-8");
  } finally {
    await handle.close();
  }
}

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
    await sleep(Math.max(0, Math.min(POLL_INTERVAL, deadline - Date.now())));

    // The sleep above is clamped to land the wake-up at (not past) the
    // deadline, so the intended final look happens right at the deadline
    // moment — that at-the-deadline check is deliberate, not a bug. What
    // IS a bug: a timer that was scheduled to fire at the deadline can, if
    // the event loop is busy elsewhere, actually resume much later than
    // that. Evaluating `check()` unconditionally at that point would let a
    // file that only appeared during that extra, unbudgeted lag slip
    // through as a pass.
    //
    // The two failure modes pull in opposite directions, so the guard has
    // to draw a deliberate line rather than reject on any overshoot: normal
    // timer resolution means even a healthy, on-time resume routinely lands
    // a few milliseconds past `deadline`, and rejecting that too would
    // silently swallow the at-the-deadline check on nearly every call,
    // turning "poll until timeout" into "poll until timeout minus one poll
    // interval" for every caller. So only an overshoot bigger than a full
    // POLL_INTERVAL — the hallmark of real event-loop lag, not scheduler
    // noise — counts as the budget having been genuinely spent, and skips
    // the final evaluation outright rather than trusting a stale-by-design
    // check. This is a fixed, deadline-relative comparison, not a race
    // against timer jitter: ordinary jitter (single-digit milliseconds)
    // never comes close to a whole POLL_INTERVAL, so it can't flip this
    // branch by accident.
    if (Date.now() - deadline > POLL_INTERVAL) {
      break;
    }

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
    content = await readBoundedFile(absolutePath);
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
