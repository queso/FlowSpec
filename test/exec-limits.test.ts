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

  it("is not defeated by a backgrounded grandchild that keeps the stdout/stderr pipes open", async () => {
    // Regression test: SIGTERM-then-SIGKILL escalation kills the DIRECT
    // child, but a detached grandchild it spawned (here, `sleep 20 &`)
    // inherits the same stdout/stderr pipes and holds them open for its own
    // lifetime. Reading those streams to EOF therefore does NOT finish when
    // the child dies, and an implementation that awaits the reads
    // unconditionally alongside proc.exited hangs for the grandchild's full
    // lifetime — verified empirically against the pre-fix code: a 500ms
    // timeout was still pending 5000ms later, 10x its own deadline. A
    // correct implementation bounds the post-exit drain and returns
    // whatever was already buffered, so the timeout is a real deadline.
    //
    // The call is raced against the test's own deadline rather than just
    // having its elapsed time measured: against the buggy code it never
    // settles at all, which would hang the whole test file instead of
    // failing this one test.
    const deadlineMs = 2000;
    const start = Date.now();
    const outcome = await Promise.race([
      spawnProcess(["sh", "-c", "sleep 20 & echo started; sleep 30"], {
        timeout: 500,
      }).then((result) => ({ kind: "resolved" as const, result })),
      new Promise<{ kind: "deadline" }>((resolve) =>
        setTimeout(() => resolve({ kind: "deadline" }), deadlineMs),
      ),
    ]);
    const elapsed = Date.now() - start;

    expect(outcome.kind).toBe("resolved");
    expect(elapsed).toBeLessThan(deadlineMs);
    if (outcome.kind === "resolved") {
      expect(outcome.result.timedOut).toBe(true);
      // Output buffered before the drain was abandoned is still reported,
      // exactly as it is for the ordinary kill case above — bounding the
      // wait must not mean discarding what was already captured.
      expect(outcome.result.stdout).toContain("started");
    }
  });

  it("returns promptly when the command itself exits but a backgrounded grandchild holds the pipes open", async () => {
    // The same pipe-inheritance problem without any timeout expiring: `sh`
    // exits immediately here, so this is a completely successful run whose
    // streams simply never reach EOF. Pre-fix, this hung indefinitely even
    // though the command had already succeeded.
    const deadlineMs = 2000;
    const outcome = await Promise.race([
      spawnProcess(["sh", "-c", "sleep 20 & echo started"], {
        timeout: 10000,
      }).then((result) => ({ kind: "resolved" as const, result })),
      new Promise<{ kind: "deadline" }>((resolve) =>
        setTimeout(() => resolve({ kind: "deadline" }), deadlineMs),
      ),
    ]);

    expect(outcome.kind).toBe("resolved");
    if (outcome.kind === "resolved") {
      expect(outcome.result.timedOut).toBe(false);
      expect(outcome.result.exitCode).toBe(0);
      expect(outcome.result.stdout).toContain("started");
    }
  });

  it("treats an explicit timeout of 0 as kill-immediately, not as no-limit", async () => {
    // Pins the primitive-level semantics of the falsy-but-present value: 0
    // is a real deadline of zero milliseconds, so the child is killed at
    // once and timedOut is true. It must NOT be silently treated as
    // "unset"/no-limit (which would let this 10s sleep run to completion),
    // and it must not throw. Callers that mean "no limit" leave timeout
    // undefined; choosing a sane default for an unset/zero config value is
    // the surface layer's job, not this primitive's.
    const start = Date.now();
    const result = await spawnProcess(
      [process.execPath, "-e", "setTimeout(() => {}, 10000)"],
      { timeout: 0 },
    );
    const elapsed = Date.now() - start;

    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(2000);
    expect(result.stderr).toContain("timed out after 0ms");
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

  it("truncates cleanly at a captureLimit that lands mid-character, without splitting the multi-byte UTF-8 sequence", async () => {
    // Regression test (CodeRabbit review, PR #16): captureLimit is a BYTE
    // ceiling, but every other truncation fixture in this file uses
    // single-byte ASCII, so a byte-level slice landing inside a multi-byte
    // UTF-8 sequence was never exercised. "é" is U+00E9, encoded as the
    // 2-byte UTF-8 sequence 0xC3 0xA9. captureLimit: 5 lands after 2 whole
    // characters (4 bytes) plus one stray leading byte (0xC3) of a third —
    // a byte offset that sits mid-character. A blind byte slice fed
    // straight to TextDecoder would decode that dangling lead byte as a
    // U+FFFD replacement-character artifact instead of cleanly stopping
    // before it.
    const char = "é";
    const captureLimit = 5;
    const written = char.repeat(50);
    const result = await spawnProcess(
      [
        process.execPath,
        "-e",
        `process.stdout.write(${JSON.stringify(written)})`,
      ],
      { captureLimit },
    );
    expect(result.truncated).toBe(true);
    // The captured head must be exactly the whole characters that fit
    // (2 of them, "éé") plus the truncation marker — never a partial
    // character or a replacement-character artifact.
    expect(result.stdout).toBe(`${char.repeat(2)}[truncated]`);
    expect(result.stdout).not.toContain("�");
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
