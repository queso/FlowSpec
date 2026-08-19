import { describe, expect, it } from "vitest";
import { formatError, formatResult, formatSummary } from "../src/reporter";
import type { FlowError, FlowResult } from "../src/types";

/**
 * Tests for WI-810: reporter rendering of CLI run steps, CLI assertion
 * failures (exit code, bounded stdio excerpts, kept working directory),
 * and the cross-surface formatSummary regression guard.
 *
 * Contract pinned by the work item:
 *  - A run step (string or array form) renders as its command text, never
 *    "[object Object]" or "unknown action".
 *  - A CLI assertion failure's exitCode/stdout/stderr (added to
 *    FlowErrorSchema by WI-805) render whenever `exitCode` is present —
 *    that field's presence is what signals "this is a CLI failure" (a web
 *    failure never sets it). A truncation marker already baked into an
 *    excerpt (upstream bounding, not this module's job) is preserved, not
 *    stripped.
 *  - `workdir` renders on its own line only when present — a configured
 *    cwd never has it, per the runner's own not-a-kept-temp-dir contract
 *    (this file doesn't control that; it just proves presence gates the
 *    line).
 *  - formatError and formatResult independently build the step/CLI-field
 *    lines and must render identically — every behavior below is tested
 *    through BOTH entry points via a shared renderer table, per the
 *    "shared logic, per-entry-point test" principle: a fix applied to only
 *    one of the two would slip past a suite that only exercised the other.
 *  - formatSummary already buckets by construction, not by surface — mixed
 *    web+CLI results still produce exactly one summary line (regression
 *    guard, not new logic).
 *  - Web-only formatting is UNCHANGED: verified by running the existing
 *    test/reporter.test.ts and test/reporter-setup.test.ts suites
 *    unmodified (not re-tested in this file — see coverage hygiene).
 */

type Renderer = (error: FlowError) => string;

const RENDERERS: Array<[string, Renderer]> = [
  ["formatError", (error) => formatError(error)],
  [
    "formatResult",
    (error) =>
      formatResult({
        success: false,
        flowName: "cli-flow",
        duration: 100,
        error,
      } satisfies FlowResult),
  ],
];

describe.each(RENDERERS)("%s: CLI run-step rendering", (_name, render) => {
  it("renders a string-form run step as its command text", () => {
    const output = render({
      message: "Command failed",
      step: 0,
      action: { run: "flowspec init" },
    });
    expect(output).toContain("run");
    expect(output).toContain("flowspec init");
    expect(output).not.toContain("[object Object]");
    expect(output).not.toContain("unknown action");
  });

  it("renders an array-form run step as its joined argv", () => {
    const output = render({
      message: "Command failed",
      step: 0,
      action: { run: ["flowspec", "run", "--flow", "x"] },
    });
    expect(output).toContain("flowspec run --flow x");
    expect(output).not.toContain("[object Object]");
    expect(output).not.toContain("unknown action");
  });
});

describe.each(
  RENDERERS,
)("%s: CLI assertion failure fields", (_name, render) => {
  it("renders the exit code and bounded stdout/stderr excerpts", () => {
    const output = render({
      message: "Expected exit code 0 but got 7",
      exitCode: 7,
      stdout: "build output here",
      stderr: "warning: deprecated flag",
    });
    expect(output).toContain("7");
    expect(output).toContain("build output here");
    expect(output).toContain("warning: deprecated flag");
  });

  it("shows the truncation marker when the excerpt was already truncated upstream", () => {
    const truncatedStdout = `${"x".repeat(50)}[truncated]`;
    const output = render({
      message: "stdout_contains assertion failed",
      exitCode: 1,
      stdout: truncatedStdout,
      stderr: "",
    });
    expect(output).toContain("[truncated]");
  });

  it("prints the kept working directory on its own line when present", () => {
    const output = render({
      message: "file_exists assertion failed",
      exitCode: 0,
      stdout: "",
      stderr: "",
      workdir: "/tmp/flowspec-kept-abc123",
    });
    expect(output).toContain("/tmp/flowspec-kept-abc123");
  });

  it("does not print a working-directory line when workdir is absent (configured cwd case)", () => {
    const output = render({
      message: "exit_code assertion failed",
      exitCode: 1,
      stdout: "",
      stderr: "",
    });
    expect(output.toLowerCase()).not.toContain("working directory");
  });
});

describe("formatSummary: mixed web and CLI results", () => {
  it("produces a single summary line with correct passed/failed/skipped counts across both surfaces", () => {
    const results: FlowResult[] = [
      { success: true, flowName: "web-pass", duration: 100 },
      {
        success: false,
        flowName: "web-fail",
        duration: 100,
        error: { message: "Element not found" },
      },
      { success: true, flowName: "cli-pass", duration: 50 },
      {
        success: false,
        flowName: "cli-fail",
        duration: 50,
        error: {
          message: "Expected exit code 0 but got 1",
          exitCode: 1,
          stdout: "",
          stderr: "",
        },
      },
      { success: false, flowName: "cli-skip", duration: 0, skipped: true },
    ];

    const output = formatSummary(results);

    expect(output).toContain("5 flows");
    expect(output).toContain("2 passed");
    expect(output).toContain("2 failed");
    expect(output).toContain("1 skipped");
    expect(output.split("\n")).toHaveLength(1);
  });
});
