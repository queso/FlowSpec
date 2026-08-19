import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateCliAssertion } from "../src/cli-assertions";
import * as FileMatchersModule from "../src/file-matchers";
import * as MatchersModule from "../src/matchers";
import { EXCERPT_LIMIT } from "../src/matchers";
import { POLL_INTERVAL } from "../src/runner";

/**
 * Tests for WI-809: the CLI assertion dispatcher — evaluates one of the
 * eight CLI assertions against a completed run step's captured result.
 *
 * Contract pinned by the work item:
 *  - evaluateCliAssertion(assertion, lastStep, workdir, timeout) where
 *    lastStep is { stdout: string; stderr: string; exitCode: number }.
 *    Returns undefined on pass, or a failure object on fail:
 *    { message: string; exitCode: number; stdout: string; stderr: string; workdir: string }
 *    — every field always populated on failure, regardless of which
 *    assertion type failed (exitCode/stdout/stderr are the LAST STEP's
 *    values, bounded via src/matchers.ts's EXCERPT_LIMIT, not re-derived
 *    per assertion type).
 *  - exit_code, stdout_contains/matches, stderr_contains/matches, and
 *    json_output all evaluate EXACTLY ONCE — no retry/poll — even when a
 *    nonzero timeout is supplied.
 *  - file_exists / file_contains DO retry within the timeout window, and
 *    resolve a relative assertion path against `workdir` before handing an
 *    absolute path to src/file-matchers.ts.
 *  - This module delegates real matching to src/matchers.ts and
 *    src/file-matchers.ts (never reimplements substring/regex/JSON/file
 *    logic inline) — verified below with bare module spies, per the
 *    Integration Item Wiring Tests convention, since this item's whole job
 *    is wiring three already-tested modules together.
 *
 * Return-shape design note (mine — no prior convention existed): this
 * module returns a minimal CliAssertionFailure, NOT a full FlowError. It
 * does not set FlowErrorSchema's `assertion` field (which is still typed
 * web-only, StepAssertionSchema, and was not widened by WI-805) — only
 * `message`, `exitCode`, `stdout`, `stderr`, `workdir` are this module's
 * concern. Assembling a full FlowError (adding `step`, `phase`, etc.) is
 * the CLI runner item's job, one layer up.
 */

function lastStep(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    stdout: "some output",
    stderr: "",
    exitCode: 0,
    ...overrides,
  };
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "flowspec-cli-assertions-")),
  );
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("exit_code", () => {
  it("passes when it equals the last run step's exit code", async () => {
    const result = await evaluateCliAssertion(
      { exit_code: 0 },
      lastStep({ exitCode: 0 }),
      "/tmp/irrelevant",
      0,
    );
    expect(result).toBeUndefined();
  });

  it("fails naming both the expected and actual code when they differ", async () => {
    const result = await evaluateCliAssertion(
      { exit_code: 0 },
      lastStep({ exitCode: 7 }),
      "/tmp/irrelevant",
      0,
    );
    expect(result).toBeDefined();
    expect(result?.message).toContain("0");
    expect(result?.message).toContain("7");
  });

  it("evaluates exactly once with no retry, even when a timeout is configured", async () => {
    const start = Date.now();
    const result = await evaluateCliAssertion(
      { exit_code: 0 },
      lastStep({ exitCode: 7 }),
      "/tmp/irrelevant",
      5000,
    );
    const elapsed = Date.now() - start;
    expect(result).toBeDefined();
    expect(elapsed).toBeLessThan(POLL_INTERVAL);
  });
});

describe("stdout_contains / stderr_contains", () => {
  it("stdout_contains passes when the needle is present in stdout", async () => {
    const result = await evaluateCliAssertion(
      { stdout_contains: "some" },
      lastStep({ stdout: "some output" }),
      "/tmp/irrelevant",
      0,
    );
    expect(result).toBeUndefined();
  });

  it("stdout_contains fails with a bounded excerpt of stdout when absent", async () => {
    const result = await evaluateCliAssertion(
      { stdout_contains: "missing-needle" },
      lastStep({ stdout: "some output" }),
      "/tmp/irrelevant",
      0,
    );
    expect(result).toBeDefined();
    expect(result?.message).toContain("some output");
  });

  it("stderr_contains passes when the needle is present in stderr", async () => {
    const result = await evaluateCliAssertion(
      { stderr_contains: "boom" },
      lastStep({ stderr: "error: boom happened" }),
      "/tmp/irrelevant",
      0,
    );
    expect(result).toBeUndefined();
  });

  it("stderr_contains fails with a bounded excerpt of stderr when absent", async () => {
    const result = await evaluateCliAssertion(
      { stderr_contains: "missing" },
      lastStep({ stderr: "error: boom happened" }),
      "/tmp/irrelevant",
      0,
    );
    expect(result).toBeDefined();
    expect(result?.message).toContain("boom happened");
  });

  it("evaluates exactly once with no retry, even when a timeout is configured", async () => {
    const start = Date.now();
    const result = await evaluateCliAssertion(
      { stdout_contains: "missing-needle" },
      lastStep({ stdout: "some output" }),
      "/tmp/irrelevant",
      5000,
    );
    const elapsed = Date.now() - start;
    expect(result).toBeDefined();
    expect(elapsed).toBeLessThan(POLL_INTERVAL);
  });

  it("delegates to the real matchContains primitive", async () => {
    const spy = vi.spyOn(MatchersModule, "matchContains");
    await evaluateCliAssertion(
      { stdout_contains: "some" },
      lastStep({ stdout: "some output" }),
      "/tmp/irrelevant",
      0,
    );
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("stdout_matches / stderr_matches", () => {
  it("stdout_matches passes when the pattern matches stdout", async () => {
    const result = await evaluateCliAssertion(
      { stdout_matches: "^\\d{3}-\\d{4}$" },
      lastStep({ stdout: "555-1234" }),
      "/tmp/irrelevant",
      0,
    );
    expect(result).toBeUndefined();
  });

  it("stdout_matches fails with a bounded excerpt of stdout when it does not match", async () => {
    const result = await evaluateCliAssertion(
      { stdout_matches: "^\\d{3}-\\d{4}$" },
      lastStep({ stdout: "not-a-phone-number" }),
      "/tmp/irrelevant",
      0,
    );
    expect(result).toBeDefined();
    expect(result?.message).toContain("not-a-phone-number");
  });

  it("stderr_matches passes when the pattern matches stderr", async () => {
    const result = await evaluateCliAssertion(
      { stderr_matches: "^error:" },
      lastStep({ stderr: "error: something broke" }),
      "/tmp/irrelevant",
      0,
    );
    expect(result).toBeUndefined();
  });

  it("stderr_matches fails with a bounded excerpt of stderr when it does not match", async () => {
    const result = await evaluateCliAssertion(
      { stderr_matches: "^error:" },
      lastStep({ stderr: "warning: something odd" }),
      "/tmp/irrelevant",
      0,
    );
    expect(result).toBeDefined();
    expect(result?.message).toContain("warning: something odd");
  });

  it("evaluates exactly once with no retry, even when a timeout is configured", async () => {
    const start = Date.now();
    const result = await evaluateCliAssertion(
      { stdout_matches: "^\\d{3}-\\d{4}$" },
      lastStep({ stdout: "not-a-phone-number" }),
      "/tmp/irrelevant",
      5000,
    );
    const elapsed = Date.now() - start;
    expect(result).toBeDefined();
    expect(elapsed).toBeLessThan(POLL_INTERVAL);
  });

  it("delegates to the real matchRegex primitive", async () => {
    const spy = vi.spyOn(MatchersModule, "matchRegex");
    await evaluateCliAssertion(
      { stdout_matches: "^\\d{3}-\\d{4}$" },
      lastStep({ stdout: "555-1234" }),
      "/tmp/irrelevant",
      0,
    );
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("json_output", () => {
  it("passes when the dot-path value equals the expected value", async () => {
    const result = await evaluateCliAssertion(
      { json_output: { path: "$.a.b", equals: 2 } },
      lastStep({ stdout: '{"a":{"b":2}}' }),
      "/tmp/irrelevant",
      0,
    );
    expect(result).toBeUndefined();
  });

  it("fails naming both the expected and actual values when they differ", async () => {
    const result = await evaluateCliAssertion(
      { json_output: { path: "$.a.b", equals: 3 } },
      lastStep({ stdout: '{"a":{"b":2}}' }),
      "/tmp/irrelevant",
      0,
    );
    expect(result).toBeDefined();
    expect(result?.message).toContain("3");
    expect(result?.message).toContain("2");
  });

  it("fails with the parse message and a bounded head of stdout when stdout is not JSON, without crashing", async () => {
    const result = await evaluateCliAssertion(
      { json_output: { path: "$.a", equals: 1 } },
      lastStep({ stdout: "not valid json {{{" }),
      "/tmp/irrelevant",
      0,
    );
    expect(result).toBeDefined();
    expect(result?.message).toContain("not valid json {{{");
  });

  it("evaluates exactly once with no retry, even when a timeout is configured", async () => {
    const start = Date.now();
    const result = await evaluateCliAssertion(
      { json_output: { path: "$.a.b", equals: 3 } },
      lastStep({ stdout: '{"a":{"b":2}}' }),
      "/tmp/irrelevant",
      5000,
    );
    const elapsed = Date.now() - start;
    expect(result).toBeDefined();
    expect(elapsed).toBeLessThan(POLL_INTERVAL);
  });

  it("delegates to the real matchJsonPath primitive", async () => {
    const spy = vi.spyOn(MatchersModule, "matchJsonPath");
    await evaluateCliAssertion(
      { json_output: { path: "$.a.b", equals: 2 } },
      lastStep({ stdout: '{"a":{"b":2}}' }),
      "/tmp/irrelevant",
      0,
    );
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("file_exists", () => {
  it("resolves a relative path against workdir and passes when the file is already present", async () => {
    const workdir = makeTempDir();
    writeFileSync(join(workdir, "output.txt"), "content");

    const result = await evaluateCliAssertion(
      { file_exists: "output.txt" },
      lastStep(),
      workdir,
      0,
    );
    expect(result).toBeUndefined();
  });

  it("retries within the timeout window and passes once the file appears mid-window", async () => {
    const workdir = makeTempDir();
    const filePath = join(workdir, "appears-later.txt");

    const resultPromise = evaluateCliAssertion(
      { file_exists: "appears-later.txt" },
      lastStep(),
      workdir,
      1000,
    );
    setTimeout(() => writeFileSync(filePath, "now it exists"), 300);
    const result = await resultPromise;

    expect(result).toBeUndefined();
  });

  it("fails after the deadline naming the resolved absolute path when the file never appears", async () => {
    const workdir = makeTempDir();

    const result = await evaluateCliAssertion(
      { file_exists: "never-appears.txt" },
      lastStep(),
      workdir,
      POLL_INTERVAL + 50,
    );

    expect(result).toBeDefined();
    expect(result?.message).toContain(join(workdir, "never-appears.txt"));
  });

  it("delegates to the real fileExists primitive", async () => {
    const workdir = makeTempDir();
    writeFileSync(join(workdir, "output.txt"), "content");
    const spy = vi.spyOn(FileMatchersModule, "fileExists");

    await evaluateCliAssertion(
      { file_exists: "output.txt" },
      lastStep(),
      workdir,
      0,
    );

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("file_contains", () => {
  it("resolves a relative path against workdir and passes when the file already contains the expected text", async () => {
    const workdir = makeTempDir();
    writeFileSync(join(workdir, "output.txt"), "the needle is here");

    const result = await evaluateCliAssertion(
      { file_contains: { path: "output.txt", text: "needle" } },
      lastStep(),
      workdir,
      0,
    );
    expect(result).toBeUndefined();
  });

  it("fails after the deadline naming the resolved absolute path when the file never appears", async () => {
    const workdir = makeTempDir();

    const result = await evaluateCliAssertion(
      { file_contains: { path: "never-appears.txt", text: "needle" } },
      lastStep(),
      workdir,
      POLL_INTERVAL + 50,
    );

    expect(result).toBeDefined();
    expect(result?.message).toContain(join(workdir, "never-appears.txt"));
  });

  it("delegates to the real fileContains primitive", async () => {
    const workdir = makeTempDir();
    writeFileSync(join(workdir, "output.txt"), "the needle is here");
    const spy = vi.spyOn(FileMatchersModule, "fileContains");

    await evaluateCliAssertion(
      { file_contains: { path: "output.txt", text: "needle" } },
      lastStep(),
      workdir,
      0,
    );

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("every failure carries the last step's exit code, bounded stdout/stderr excerpts, and workdir", () => {
  it("an exit_code failure carries stdout, stderr, and workdir alongside exitCode", async () => {
    const result = await evaluateCliAssertion(
      { exit_code: 0 },
      lastStep({ exitCode: 1, stdout: "out text", stderr: "err text" }),
      "/tmp/some-workdir",
      0,
    );
    expect(result?.exitCode).toBe(1);
    expect(result?.stdout).toBe("out text");
    expect(result?.stderr).toBe("err text");
    expect(result?.workdir).toBe("/tmp/some-workdir");
  });

  it("a stdout_contains failure ALSO carries the last step's exit code and workdir, not just its own excerpt", async () => {
    const result = await evaluateCliAssertion(
      { stdout_contains: "missing" },
      lastStep({ exitCode: 2, stdout: "present output", stderr: "" }),
      "/tmp/another-workdir",
      0,
    );
    expect(result?.exitCode).toBe(2);
    expect(result?.workdir).toBe("/tmp/another-workdir");
  });

  it("a file_exists failure ALSO carries the last step's exitCode, stdout, and stderr, not just the file failure info", async () => {
    const workdir = makeTempDir();

    const result = await evaluateCliAssertion(
      { file_exists: "never-appears.txt" },
      lastStep({ exitCode: 0, stdout: "step output", stderr: "step stderr" }),
      workdir,
      0,
    );

    expect(result?.exitCode).toBe(0);
    expect(result?.stdout).toBe("step output");
    expect(result?.stderr).toBe("step stderr");
    expect(result?.workdir).toBe(workdir);
  });

  it("bounds a long stdout excerpt to EXCERPT_LIMIT rather than attaching the full raw text", async () => {
    const longStdout = "x".repeat(EXCERPT_LIMIT * 5);
    const result = await evaluateCliAssertion(
      { exit_code: 0 },
      lastStep({ exitCode: 1, stdout: longStdout }),
      "/tmp/irrelevant",
      0,
    );
    expect(result).toBeDefined();
    expect(result?.stdout.length).toBeLessThan(longStdout.length);
  });
});
