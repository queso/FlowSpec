import { describe, expect, it } from "vitest";
import { FlowSpecSchema } from "../src/types";

/**
 * Tests for WI-800: the optional `surface` discriminator on FlowSpecSchema
 * plus the CLI run-step grammar (run + stdin/env/timeout/expect_exit), and
 * parse-time rejection of surface/verb mismatches.
 *
 * Contract pinned by the work item (see prd/0007-cli-surface-adapter.md):
 *  - `surface` is optional on FlowSpecSchema; absent (or explicit "web")
 *    resolves to "web". Only "web" and "cli" are accepted.
 *  - A `surface: cli` flow's steps/setup must use the CLI step grammar
 *    (`run` + optional stdin/env/timeout/expect_exit); a web flow's
 *    steps/setup must use the existing web verbs. Using the wrong verb
 *    family for a flow's surface is a parse error naming the verb and the
 *    flow's surface, in both directions and in both `steps` and `setup`.
 *  - The CLI assertion list was empty as of this item: `expect` must be
 *    `[]` for a `surface: cli` flow, and a non-CLI (web-shaped) entry is a
 *    parse error naming the offending assertion and the surface. WI-805
 *    later filled in the real CLI assertion vocabulary (exit_code,
 *    stdout_contains, etc. — see test/types-cli-assertions.test.ts), so
 *    "any entry rejected" is no longer literally true; what's still true,
 *    and still this file's concern, is that a WEB-shaped assertion is
 *    never valid in a CLI flow. The post-mission sweep (fix S7) then
 *    extended the web surface's "at least one assertion" floor to the CLI
 *    surface too, so `expect: []` is now rejected on BOTH surfaces — the
 *    fixtures below carry a real assertion for that reason.
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
    // Non-empty since the post-mission sweep (fix S7): a CLI flow's expect
    // list must hold at least one assertion, exactly as a web flow's always
    // has. See the "surface: cli assertion list" block below.
    expect: [{ exit_code: 0 }],
    ...overrides,
  };
}

describe("FlowSpecSchema surface field", () => {
  it("parses a flow with no surface key and resolves surface to 'web'", () => {
    const result = FlowSpecSchema.safeParse(webFlow());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.surface).toBe("web");
    }
  });

  it("parses a flow with an explicit surface: 'web'", () => {
    const result = FlowSpecSchema.safeParse(webFlow({ surface: "web" }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.surface).toBe("web");
    }
  });

  it("rejects an unrecognized surface value, naming the value and listing accepted surfaces", () => {
    const result = FlowSpecSchema.safeParse(webFlow({ surface: "api" }));
    expect(result.success).toBe(false);
    const message = issueMessages(result);
    expect(message).toContain("api");
    expect(message).toContain("web");
    expect(message).toContain("cli");
  });
});

describe("surface: cli run-step grammar", () => {
  it("parses a cli flow with a string-form run step", () => {
    const result = FlowSpecSchema.safeParse(
      cliFlow({ steps: [{ run: "flowspec init" }] }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.surface).toBe("cli");
      expect(result.data.steps[0]).toEqual({ run: "flowspec init" });
    }
  });

  it("parses a cli flow with an array-form run step", () => {
    const result = FlowSpecSchema.safeParse(
      cliFlow({
        steps: [{ run: ["flowspec", "init", "--dir", "./p"] }],
      }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.steps[0]).toEqual({
        run: ["flowspec", "init", "--dir", "./p"],
      });
    }
  });

  it.each([
    ["stdin", { run: "flowspec init", stdin: "y\n" }],
    ["env", { run: "flowspec init", env: { NO_COLOR: "1" } }],
    ["timeout", { run: "flowspec init", timeout: 5000 }],
    ["expect_exit of 1", { run: "flowspec init", expect_exit: 1 }],
    ["expect_exit of 0", { run: "flowspec init", expect_exit: 0 }],
    [
      "all modifiers together",
      {
        run: ["flowspec", "run", "--flow", "spec with spaces.flow.yaml"],
        env: { NO_COLOR: "1" },
        stdin: "y\n",
        timeout: 5000,
        expect_exit: 0,
      },
    ],
  ])("accepts a run step with %s", (_label, step) => {
    const result = FlowSpecSchema.safeParse(cliFlow({ steps: [step] }));
    expect(result.success).toBe(true);
  });

  it("names the unknown key when a run step has an extra field", () => {
    const result = FlowSpecSchema.safeParse(
      cliFlow({ steps: [{ run: "flowspec init", bogus_key: "nope" }] }),
    );
    expect(result.success).toBe(false);
    expect(issueMessages(result)).toContain("bogus_key");
  });

  it.each([
    ["run is missing", { stdin: "y\n" }],
    ["run is a number", { run: 42 }],
    ["run array contains a non-string element", { run: ["flowspec", 123] }],
    ["stdin is a number", { run: "flowspec init", stdin: 123 }],
    ["env value is a number", { run: "flowspec init", env: { NO_COLOR: 1 } }],
    ["env is not an object", { run: "flowspec init", env: "NO_COLOR=1" }],
    ["timeout is zero", { run: "flowspec init", timeout: 0 }],
    ["timeout is negative", { run: "flowspec init", timeout: -100 }],
    ["timeout is not a number", { run: "flowspec init", timeout: "5000" }],
    [
      "expect_exit is not an integer",
      { run: "flowspec init", expect_exit: 1.5 },
    ],
    ["expect_exit is not a number", { run: "flowspec init", expect_exit: "1" }],
  ])("rejects a cli run step where %s", (_label, step) => {
    const result = FlowSpecSchema.safeParse(cliFlow({ steps: [step] }));
    expect(result.success).toBe(false);
  });

  it("still requires at least one step for a cli flow (steps: [] is rejected)", () => {
    const result = FlowSpecSchema.safeParse(cliFlow({ steps: [] }));
    expect(result.success).toBe(false);
  });
});

describe("surface/verb mismatch", () => {
  it("rejects a click step inside a surface: cli flow, naming the verb and surface", () => {
    const result = FlowSpecSchema.safeParse(
      cliFlow({ steps: [{ click: "Submit" }] }),
    );
    expect(result.success).toBe(false);
    const message = issueMessages(result);
    expect(message).toContain("click");
    expect(message).toContain("cli");
  });

  it("rejects a run step inside a web flow with no surface key, naming the verb and surface", () => {
    const result = FlowSpecSchema.safeParse(
      webFlow({ steps: [{ run: "echo hi" }] }),
    );
    expect(result.success).toBe(false);
    const message = issueMessages(result);
    expect(message).toContain("run");
    expect(message).toContain("web");
  });

  it("rejects a run step inside an explicit surface: web flow, naming the verb and surface", () => {
    const result = FlowSpecSchema.safeParse(
      webFlow({ surface: "web", steps: [{ run: "echo hi" }] }),
    );
    expect(result.success).toBe(false);
    const message = issueMessages(result);
    expect(message).toContain("run");
    expect(message).toContain("web");
  });
});

describe("surface: cli flow setup block", () => {
  it("parses a run step inside a cli flow's setup", () => {
    const result = FlowSpecSchema.safeParse(
      cliFlow({ setup: [{ run: "seed-fixture" }] }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.setup).toEqual([{ run: "seed-fixture" }]);
    }
  });

  it("rejects a click step inside a cli flow's setup, naming the verb and surface", () => {
    const result = FlowSpecSchema.safeParse(
      cliFlow({ setup: [{ click: "Whatever" }] }),
    );
    expect(result.success).toBe(false);
    const message = issueMessages(result);
    expect(message).toContain("click");
    expect(message).toContain("cli");
  });

  it("rejects a run step inside a web flow's setup, naming the verb and surface", () => {
    const result = FlowSpecSchema.safeParse(
      webFlow({ setup: [{ run: "echo hi" }] }),
    );
    expect(result.success).toBe(false);
    const message = issueMessages(result);
    expect(message).toContain("run");
    expect(message).toContain("web");
  });
});

describe("surface: cli assertion list", () => {
  it("rejects a cli flow with an empty expect list", () => {
    // Inverted by the post-mission sweep (fix S7). WI-800 landed while the
    // CLI assertion vocabulary was still empty, so `expect: []` was the only
    // legal CLI expect list and this test pinned that. WI-805 filled the
    // vocabulary in but never applied the web surface's existing `min(1)`
    // floor to the CLI surface, leaving a CLI flow able to parse — and then
    // report green — while asserting nothing at all. See
    // test/types-cli-assertion-strictness.test.ts for the full contract.
    const result = FlowSpecSchema.safeParse(cliFlow({ expect: [] }));
    expect(result.success).toBe(false);
    expect(issueMessages(result)).toContain("at least one assertion");
  });

  it("parses a cli flow whose expect list holds a CLI assertion", () => {
    const result = FlowSpecSchema.safeParse(
      cliFlow({ expect: [{ exit_code: 0 }] }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.expect).toEqual([{ exit_code: 0 }]);
    }
  });

  it("rejects a web-shaped assertion in a cli flow, naming the assertion and the surface", () => {
    // Updated by WI-805, which filled in the real CLI assertion vocabulary:
    // a CLI flow's expect list is no longer unconditionally rejected — only
    // a non-CLI (web-shaped) entry like `url` still is, and now the message
    // names which assertion was rejected, not just the surface. See
    // test/types-cli-assertions.test.ts for exhaustive cross-surface
    // coverage of all 8 CLI / 4 web assertion shapes.
    const result = FlowSpecSchema.safeParse(
      cliFlow({ expect: [{ url: "/x" }] }),
    );
    expect(result.success).toBe(false);
    const message = issueMessages(result);
    expect(message).toContain("url");
    expect(message).toContain("cli");
  });

  it("still requires at least one assertion for a web flow (min(1) unchanged)", () => {
    const result = FlowSpecSchema.safeParse(webFlow({ expect: [] }));
    expect(result.success).toBe(false);
  });
});
