/**
 * Post-mission sweep fix S7: a CLI flow's assertion list must actually
 * assert something.
 *
 * Two gaps this file pins:
 *  1. The web surface has always required `expect` to hold at least one
 *     assertion, but the CLI surface never had that constraint applied — a
 *     `surface: cli` flow with `expect: []` parsed happily and its assertion
 *     loop passed trivially, having checked nothing. A spec that verifies
 *     nothing must not be able to report green.
 *  2. String-valued assertion payloads (the needle for a *_contains, the
 *     pattern for a *_matches, the path for file_exists/file_contains/
 *     json_output, the text for file_contains) had no minimum length, so an
 *     empty string was schema-valid — and every one of them then matches or
 *     resolves trivially, i.e. always passes.
 */

import { describe, expect, it } from "vitest";
import { FlowSpecSchema } from "../src/types";

function issueMessages(
  result: ReturnType<typeof FlowSpecSchema.safeParse>,
): string {
  return result.success
    ? ""
    : result.error.issues.map((issue) => issue.message).join(" | ");
}

function cliFlow(overrides: Record<string, unknown> = {}) {
  return {
    name: "cli-flow",
    description: "A cli flow",
    surface: "cli",
    steps: [{ run: "flowspec init" }],
    expect: [{ exit_code: 0 }],
    ...overrides,
  };
}

describe("a cli flow must assert something", () => {
  it("rejects an empty expect list for a surface: cli flow", () => {
    const result = FlowSpecSchema.safeParse(cliFlow({ expect: [] }));

    expect(result.success).toBe(false);
    const message = issueMessages(result);
    expect(message).toContain("at least one assertion");
    expect(message).toContain("cli");
  });

  it("still rejects an empty expect list for a web flow", () => {
    const result = FlowSpecSchema.safeParse({
      name: "web-flow",
      description: "A web flow",
      steps: [{ visit: "/home" }],
      expect: [],
    });

    expect(result.success).toBe(false);
    expect(issueMessages(result)).toContain("at least one assertion");
  });

  it("accepts a cli flow that declares at least one assertion", () => {
    const result = FlowSpecSchema.safeParse(cliFlow());

    expect(result.success).toBe(true);
  });
});

describe("empty-string assertion payloads are rejected", () => {
  it.each([
    ["stdout_contains", { stdout_contains: "" }],
    ["stderr_contains", { stderr_contains: "" }],
    ["stdout_matches", { stdout_matches: "" }],
    ["stderr_matches", { stderr_matches: "" }],
    ["file_exists", { file_exists: "" }],
    ["file_contains path", { file_contains: { path: "", text: "done" } }],
    ["file_contains text", { file_contains: { path: "out.txt", text: "" } }],
    ["json_output path", { json_output: { path: "", equals: "ok" } }],
  ])("rejects an empty %s", (_label, assertion) => {
    const result = FlowSpecSchema.safeParse(cliFlow({ expect: [assertion] }));

    expect(result.success).toBe(false);
  });

  it.each([
    ["stdout_contains", { stdout_contains: "ok" }],
    ["stderr_contains", { stderr_contains: "error" }],
    ["stdout_matches", { stdout_matches: "^ok$" }],
    ["stderr_matches", { stderr_matches: "^error" }],
    ["file_exists", { file_exists: "out.txt" }],
    ["file_contains", { file_contains: { path: "out.txt", text: "done" } }],
    ["json_output", { json_output: { path: "$.status", equals: "ok" } }],
    ["exit_code", { exit_code: 0 }],
  ])("still accepts a non-empty %s", (_label, assertion) => {
    const result = FlowSpecSchema.safeParse(cliFlow({ expect: [assertion] }));

    expect(result.success).toBe(true);
  });
});
