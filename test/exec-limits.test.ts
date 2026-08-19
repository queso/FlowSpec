import { describe, expect, it } from "vitest";
import { DEFAULT_CAPTURE_LIMIT, spawnProcess } from "../src/exec";

/**
 * Tests for WI-806: giving spawnProcess's ExecResult.timedOut/truncated
 * fields (stubbed always-false by WI-801) real enforcement behavior.
 *
 * Contract pinned by the work item, plus decisions this test file makes
 * explicit (no prior convention existed for these — see the handoff for
 * why each was chosen):
 *  - options.timeout (ms): on expiry, the process is killed, the promise
 *    still RESOLVES (never hangs, never rejects), ExecResult.timedOut is
 *    true, and the timeout value (in ms) appears as text in `stderr` —
 *    the conventional diagnostic stream — alongside the word "timed out".
 *  - options.captureLimit (bytes, default DEFAULT_CAPTURE_LIMIT): output
 *    beyond the cap is truncated PER STREAM, with the literal marker
 *    "[truncated]" (matching src/matchers.ts's excerpt convention)
 *    appended after the head-truncated captured text, and
 *    ExecResult.truncated is true.
 *  - A killed command's partial stdout/stderr captured before the kill
 *    are still returned (not discarded), alongside timedOut: true.
 *  - Within both limits: timedOut false, truncated false, stdout
 *    byte-identical to what the command wrote (verified with a fixture
 *    containing unicode, a newline, and a tab — not just plain ASCII).
 *
 * Not tested here (implementation-technique requirement, not an
 * observable-behavior one): the context requires truncation to be applied
 * WHILE STREAMING rather than by capturing everything and slicing
 * afterward, "or the memory bound is not real." That distinction produces
 * identical black-box output for any test fixture small enough to run in
 * a unit test — proving it would require actually flooding memory, which
 * this suite deliberately does not do. That property belongs to code
 * review of the implementation diff, not to a test assertion here.
 */

describe("timeout", () => {
  it("kills a command that runs longer than the timeout, reporting timedOut true with the limit named", async () => {
    const timeout = 200;
    const result = await spawnProcess(
      [process.execPath, "-e", "setTimeout(() => {}, 10000)"],
      { timeout },
    );
    expect(result.timedOut).toBe(true);
    expect(result.stderr).toContain(String(timeout));
    expect(result.stderr.toLowerCase()).toContain("timed out");
  });

  it("actually terminates a command that traps/ignores SIGTERM, not just sends the signal", async () => {
    // Regression test for a bug Amy found via probing: a bare kill() sends
    // SIGTERM by default. A child that installs its own SIGTERM handler and
    // ignores it (a broken or adversarial command — exactly what the
    // timeout feature exists to guard against) never dies from that signal,
    // and Bun.spawn does not escalate to SIGKILL on its own. If
    // spawnProcess only sends SIGTERM and waits, this resolves only once
    // the child's own UNRELATED 15s sleep elapses (or hangs indefinitely) —
    // not because of the timeout. A correct implementation must guarantee
    // real termination (SIGKILL directly, or SIGTERM escalating to SIGKILL
    // after a short grace period), resolving well before the child's own
    // schedule. Verified interactively against Bun 1.3.11: a bare kill()
    // against this exact fixture left the process alive at least 3000ms
    // later (25x+ the timeout), while proc.kill("SIGKILL") terminated a
    // real subprocess immediately (exit code 137).
    const timeout = 300;
    const start = Date.now();
    const result = await spawnProcess(
      [
        process.execPath,
        "-e",
        "process.on('SIGTERM', () => {}); setTimeout(() => {}, 15000);",
      ],
      { timeout },
    );
    const elapsed = Date.now() - start;

    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(3000);
  });

  it("resolves (does not hang) when the command exceeds the timeout", async () => {
    const start = Date.now();
    await spawnProcess(
      [process.execPath, "-e", "setTimeout(() => {}, 10000)"],
      { timeout: 200 },
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });

  it("returns partial stdout and stderr captured before the kill, not discarded", async () => {
    const result = await spawnProcess(
      [
        process.execPath,
        "-e",
        "process.stdout.write('hello-before-kill'); process.stderr.write('err-before-kill'); setTimeout(() => {}, 10000);",
      ],
      { timeout: 300 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toContain("hello-before-kill");
    expect(result.stderr).toContain("err-before-kill");
  });

  it("does not report timedOut for a command that finishes before the timeout", async () => {
    const result = await spawnProcess(
      [process.execPath, "-e", "process.stdout.write('quick')"],
      { timeout: 5000 },
    );
    expect(result.timedOut).toBe(false);
  });
});

describe("output capture bounds", () => {
  it("truncates stdout beyond a custom captureLimit, appending an explicit marker, and reports truncated true", async () => {
    const captureLimit = 100;
    const written = "y".repeat(captureLimit * 5);
    const result = await spawnProcess(
      [
        process.execPath,
        "-e",
        `process.stdout.write(${JSON.stringify(written)})`,
      ],
      { captureLimit },
    );
    expect(result.truncated).toBe(true);
    expect(result.stdout.startsWith(written.slice(0, captureLimit))).toBe(true);
    expect(result.stdout).toContain("[truncated]");
    expect(result.stdout.length).toBeLessThan(written.length);
  });

  it("truncates stderr independently of stdout", async () => {
    const captureLimit = 100;
    const writtenErr = "z".repeat(captureLimit * 5);
    const result = await spawnProcess(
      [
        process.execPath,
        "-e",
        `process.stdout.write('short'); process.stderr.write(${JSON.stringify(writtenErr)})`,
      ],
      { captureLimit },
    );
    expect(result.truncated).toBe(true);
    expect(result.stdout).toBe("short");
    expect(result.stderr).toContain("[truncated]");
    expect(result.stderr.length).toBeLessThan(writtenErr.length);
  });

  it("a captureLimit well under 5MB still truncates output that would fit under the 5MB default", async () => {
    const captureLimit = 1000;
    const written = "a".repeat(captureLimit * 5);
    expect(written.length).toBeLessThan(DEFAULT_CAPTURE_LIMIT);

    const result = await spawnProcess(
      [
        process.execPath,
        "-e",
        `process.stdout.write(${JSON.stringify(written)})`,
      ],
      { captureLimit },
    );
    expect(result.truncated).toBe(true);
  });

  it("uses DEFAULT_CAPTURE_LIMIT (5 MB) when no captureLimit is supplied", async () => {
    const size = DEFAULT_CAPTURE_LIMIT + 1000;
    const result = await spawnProcess([
      process.execPath,
      "-e",
      `process.stdout.write('b'.repeat(${size}))`,
    ]);
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThan(size);
  });

  it("does not truncate output that fits within the limit, reporting truncated false", async () => {
    const written = "hello world, this fits easily";
    const result = await spawnProcess([
      process.execPath,
      "-e",
      `process.stdout.write(${JSON.stringify(written)})`,
    ]);
    expect(result.truncated).toBe(false);
    expect(result.stdout).toBe(written);
  });
});

describe("within limits: exact capture, no flags set", () => {
  it("reports timedOut false and truncated false, with stdout byte-identical to what the command wrote", async () => {
    const written =
      "hello world — unicode: café, 日本語, emoji: 🎉\nwith a newline\ttab too";
    const result = await spawnProcess([
      process.execPath,
      "-e",
      `process.stdout.write(${JSON.stringify(written)})`,
    ]);
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.stdout).toBe(written);
  });
});
