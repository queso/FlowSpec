import { describe, expect, it } from "vitest";
import { FlowErrorSchema, FlowSpecSchema } from "../src/types";

/**
 * Tests for WI-805: the eight CLI assertion schemas, cross-surface
 * assertion rejection, and the CLI-aware FlowError fields — extending the
 * surface/CliStep foundation WI-800 established in src/types.ts.
 *
 * Contract pinned by the work item:
 *  - A `surface: cli` flow's `expect` list accepts exactly the eight CLI
 *    assertions: exit_code, stdout_contains, stdout_matches,
 *    stderr_contains, stderr_matches, file_exists, file_contains
 *    ({path, text}), json_output ({path, equals}).
 *  - Cross-surface assertions are parse errors in both directions, naming
 *    the offending assertion key and the flow's surface (same convention
 *    as WI-800's step-verb mismatch messages).
 *  - stdout_matches/stderr_matches values must be compilable regexes,
 *    checked at parse time.
 *  - file_contains and json_output are compound objects; a missing
 *    required sub-key is a parse error naming that key.
 *  - FlowErrorSchema gains optional exitCode (number), stdout (string),
 *    stderr (string), workdir (string) — all four absent still validates
 *    exactly like today's web FlowError shape.
 *  - FlowErrorSchema.action widens to accept a CLI run step (CliStepSchema)
 *    alongside the existing web StepActionSchema.
 *
 * NOTE for whoever implements this (see agentStop summary / handoff): the
 * existing test at test/types-cli-surface.test.ts ("rejects any expect
 * entry in a cli flow as unsupported for surface cli") pins the literal
 * substring "unsupported assertion for surface cli" for a WEB assertion
 * inside a CLI flow. This file's cross-surface tests deliberately do NOT
 * re-pin that exact phrase — they only check that the message names the
 * offending assertion key and the surface (the AC's actual requirement),
 * matching the flexible style WI-800 used for step-verb mismatches. If the
 * chosen message wording changes (e.g. to mirror the step-verb pattern
 * `Assertion "X" is not valid for surface "Y"`), that WI-800 test will need
 * a small Murdock rework touch-up — expected, not a regression, since the
 * AC now requires naming the specific assertion, which the old generic
 * phrase never did.
 */

function issueMessages(
  result: ReturnType<typeof FlowSpecSchema.safeParse>,
): string {
  return result.success
    ? ""
    : result.error.issues.map((issue) => issue.message).join(" | ");
}

function webFlow(overrides: Record<string, unknown> = {}) {
  return {
    name: "web-flow",
    description: "A web flow",
    steps: [{ visit: "/home" }],
    expect: [{ visible: "Hello" }],
    ...overrides,
  };
}

function cliFlow(overrides: Record<string, unknown> = {}) {
  return {
    name: "cli-flow",
    description: "A cli flow",
    surface: "cli",
    steps: [{ run: "flowspec init" }],
    expect: [],
    ...overrides,
  };
}

const VALID_CLI_ASSERTIONS: Array<[string, Record<string, unknown>]> = [
  ["exit_code", { exit_code: 0 }],
  ["stdout_contains", { stdout_contains: "ok" }],
  ["stdout_matches", { stdout_matches: "^ok$" }],
  ["stderr_contains", { stderr_contains: "error" }],
  ["stderr_matches", { stderr_matches: "^error" }],
  ["file_exists", { file_exists: "output.txt" }],
  ["file_contains", { file_contains: { path: "output.txt", text: "done" } }],
  ["json_output", { json_output: { path: "$.status", equals: "ok" } }],
];

const VALID_WEB_ASSERTIONS: Array<[string, Record<string, unknown>]> = [
  ["url", { url: "/dashboard" }],
  ["visible", { visible: "Welcome" }],
  ["matches", { matches: "Order #\\d+" }],
  ["not_visible", { not_visible: "Error" }],
];

describe("CLI assertion schemas: happy path", () => {
  it.each(
    VALID_CLI_ASSERTIONS,
  )("parses a cli flow whose expect list contains a %s assertion", (_key, assertion) => {
    const result = FlowSpecSchema.safeParse(cliFlow({ expect: [assertion] }));
    expect(result.success).toBe(true);
  });

  it("parses a cli flow whose expect list contains multiple CLI assertions together", () => {
    const result = FlowSpecSchema.safeParse(
      cliFlow({
        expect: [
          { exit_code: 0 },
          { stdout_contains: "done" },
          { file_exists: "out.txt" },
        ],
      }),
    );
    expect(result.success).toBe(true);
  });
});

describe("CLI assertion schemas: malformed compound assertions", () => {
  it("rejects file_contains missing 'path', naming the missing key", () => {
    const result = FlowSpecSchema.safeParse(
      cliFlow({ expect: [{ file_contains: { text: "done" } }] }),
    );
    expect(result.success).toBe(false);
    expect(issueMessages(result)).toContain("path");
  });

  it("rejects file_contains missing 'text', naming the missing key", () => {
    const result = FlowSpecSchema.safeParse(
      cliFlow({ expect: [{ file_contains: { path: "out.txt" } }] }),
    );
    expect(result.success).toBe(false);
    expect(issueMessages(result)).toContain("text");
  });

  it("rejects json_output missing 'path', naming the missing key", () => {
    const result = FlowSpecSchema.safeParse(
      cliFlow({ expect: [{ json_output: { equals: "ok" } }] }),
    );
    expect(result.success).toBe(false);
    expect(issueMessages(result)).toContain("path");
  });

  it("rejects json_output with the 'equals' key entirely absent (not just undefined), naming the missing key", () => {
    // Regression guard against a real Zod pitfall: z.object({ equals: z.unknown() })
    // happily parses a payload where "equals" is never present at all, because
    // z.unknown() accepts undefined. A correct implementation must explicitly
    // check key presence for "equals" rather than relying on z.unknown()'s
    // default (permissive) behavior.
    const result = FlowSpecSchema.safeParse(
      cliFlow({ expect: [{ json_output: { path: "$.status" } }] }),
    );
    expect(result.success).toBe(false);
    expect(issueMessages(result)).toContain("equals");
  });
});

describe("stdout_matches / stderr_matches: regex compilability", () => {
  it("rejects an uncompilable stdout_matches pattern, naming the offending pattern", () => {
    const result = FlowSpecSchema.safeParse(
      cliFlow({ expect: [{ stdout_matches: "(unclosed" }] }),
    );
    expect(result.success).toBe(false);
    expect(issueMessages(result)).toContain("(unclosed");
  });

  it("rejects an uncompilable stderr_matches pattern, naming the offending pattern", () => {
    const result = FlowSpecSchema.safeParse(
      cliFlow({ expect: [{ stderr_matches: "[unterminated" }] }),
    );
    expect(result.success).toBe(false);
    expect(issueMessages(result)).toContain("[unterminated");
  });

  it("accepts a compilable stdout_matches pattern with real regex syntax", () => {
    const result = FlowSpecSchema.safeParse(
      cliFlow({ expect: [{ stdout_matches: "^\\d{3}-\\d{4}$" }] }),
    );
    expect(result.success).toBe(true);
  });
});

describe("cross-surface: CLI assertion inside a web flow", () => {
  it.each(
    VALID_CLI_ASSERTIONS,
  )("rejects a %s assertion inside a web flow, naming the assertion and the surface", (key, assertion) => {
    const result = FlowSpecSchema.safeParse(
      webFlow({ expect: [{ visible: "Hello" }, assertion] }),
    );
    expect(result.success).toBe(false);
    const message = issueMessages(result);
    expect(message).toContain(key);
    expect(message).toContain("web");
  });
});

describe("cross-surface: web assertion inside a CLI flow", () => {
  it.each(
    VALID_WEB_ASSERTIONS,
  )("rejects a %s assertion inside a cli flow, naming the assertion and the surface", (key, assertion) => {
    const result = FlowSpecSchema.safeParse(cliFlow({ expect: [assertion] }));
    expect(result.success).toBe(false);
    const message = issueMessages(result);
    expect(message).toContain(key);
    expect(message).toContain("cli");
  });
});

describe("FlowErrorSchema: CLI-aware fields", () => {
  it("accepts exitCode, stdout, stderr, and workdir all together", () => {
    const result = FlowErrorSchema.safeParse({
      message: "Exit code assertion failed",
      exitCode: 1,
      stdout: "partial output",
      stderr: "some error text",
      workdir: "/tmp/flowspec-abc123",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.exitCode).toBe(1);
      expect(result.data.stdout).toBe("partial output");
      expect(result.data.stderr).toBe("some error text");
      expect(result.data.workdir).toBe("/tmp/flowspec-abc123");
    }
  });

  it.each([
    ["exitCode", { exitCode: 2 }],
    ["stdout", { stdout: "out" }],
    ["stderr", { stderr: "err" }],
    ["workdir", { workdir: "/tmp/flowspec-xyz" }],
  ])("accepts %s independently of the other three", (_field, partial) => {
    const result = FlowErrorSchema.safeParse({
      message: "failed",
      ...partial,
    });
    expect(result.success).toBe(true);
  });

  it("still validates a plain web FlowError with all four CLI fields absent", () => {
    const result = FlowErrorSchema.safeParse({
      message: "Element not found",
      step: 2,
      action: { click: "Submit" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.exitCode).toBeUndefined();
      expect(result.data.stdout).toBeUndefined();
      expect(result.data.stderr).toBeUndefined();
      expect(result.data.workdir).toBeUndefined();
    }
  });
});

describe("FlowErrorSchema.action: widened to accept a CLI run step", () => {
  it("accepts a CLI action with a string-form run", () => {
    const result = FlowErrorSchema.safeParse({
      message: "Command failed",
      action: { run: "flowspec init" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a CLI action with an array-form run and modifiers", () => {
    const result = FlowErrorSchema.safeParse({
      message: "Command timed out",
      action: { run: ["node", "-e", "x"], timeout: 5000 },
    });
    expect(result.success).toBe(true);
  });

  it("still accepts an existing web action, unchanged", () => {
    const result = FlowErrorSchema.safeParse({
      message: "Element not found",
      action: { click: "Submit" },
    });
    expect(result.success).toBe(true);
  });
});
