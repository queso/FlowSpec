import { describe, expect, it } from "vitest";
import {
  asCliFlow,
  asWebFlow,
  type FlowSpec,
  FlowSpecSchema,
} from "../src/types";

/**
 * Tests for the CodeRabbit review fix (PR #16): asCliFlow/asWebFlow gain
 * their own runtime validation instead of being unchecked `as` casts.
 *
 * Context: FlowSpecSchema's superRefine already rejects, at parse time, any
 * flow whose steps/setup/expect don't match its declared surface. asCliFlow/
 * asWebFlow (src/types.ts) narrow an already-parsed FlowSpec to its surface-
 * specific type (CliFlowSpec/WebFlowSpec) for callers like runFlow
 * (src/runner.ts) that dispatch on `surface`. Historically this narrowing
 * was a bare `as` cast with no runtime check of its own — fine for the one
 * production call site (runFlow, which only ever passes an
 * already-FlowSpecSchema-parsed value), but a real gap for any caller that
 * builds a flow object without going through FlowSpecSchema at all: nothing
 * downstream of asCliFlow/asWebFlow would ever validate it. The project's
 * own test fixtures already do exactly this (see test/cli-runner.test.ts's
 * `cliFlow()` helper, `as unknown as CliFlowSpec`), so the gap is not
 * hypothetical.
 *
 * These tests build a hand-crafted, TypeScript-legal-looking FlowSpec that
 * bypasses FlowSpecSchema entirely (mirroring what a misbehaving caller, or
 * exactly those test fixtures, could construct) and confirm asCliFlow/
 * asWebFlow now reject a value whose steps/expect don't match its own
 * `surface`, rather than silently returning it.
 */

function unvalidatedCliFlow(overrides: Record<string, unknown> = {}) {
  return {
    name: "cli-flow",
    description: "A cli flow",
    surface: "cli",
    steps: [{ run: "flowspec init" }],
    expect: [{ exit_code: 0 }],
    ...overrides,
  } as unknown as FlowSpec;
}

function unvalidatedWebFlow(overrides: Record<string, unknown> = {}) {
  return {
    name: "web-flow",
    description: "A web flow",
    surface: "web",
    steps: [{ visit: "/home" }],
    expect: [{ visible: "Hello" }],
    ...overrides,
  } as unknown as FlowSpec;
}

describe("asCliFlow: runtime validation", () => {
  it("accepts a well-formed, already-validated cli flow and returns it usable as CliFlowSpec", () => {
    const parsed = FlowSpecSchema.parse(unvalidatedCliFlow());
    const cliFlow = asCliFlow(parsed);
    expect(cliFlow.surface).toBe("cli");
    expect(cliFlow.steps).toEqual([{ run: "flowspec init" }]);
    expect(cliFlow.expect).toEqual([{ exit_code: 0 }]);
  });

  it("rejects a hand-built cli-surface flow whose steps carry a web verb, instead of silently casting it", () => {
    // TypeScript's FlowSpec["steps"] type (z.custom<FlowStep | CliStep>())
    // happily accepts { click: ... } — the real enforcement lives in
    // FlowSpecSchema's superRefine, which this object never went through.
    // This is exactly what test/cli-runner.test.ts's cliFlow() fixture (and
    // any other caller that skips FlowSpecSchema) can hand asCliFlow.
    const malformed = unvalidatedCliFlow({
      steps: [{ click: "Login" }],
    });

    expect(() => asCliFlow(malformed)).toThrow();
  });

  it("rejects a hand-built cli-surface flow whose expect list carries a web assertion", () => {
    const malformed = unvalidatedCliFlow({
      expect: [{ visible: "Hello" }],
    });

    expect(() => asCliFlow(malformed)).toThrow();
  });

  it("does not reject a cli-surface flow with an empty expect list — that authoring floor is FlowSpecSchema's job, not this grammar check", () => {
    // test/runner-dispatch.test.ts's own cliFlow() fixture builds exactly
    // this shape (surface: "cli", a hand-cast object, expect: []) and feeds
    // it straight into runFlow to test dispatch/execution mechanics that
    // have nothing to do with assertions. asCliFlow re-validating "must
    // assert something" here would reject that legitimate, established
    // pattern for a reason unrelated to what this check exists to catch (a
    // wrong-surface verb slipping through an unchecked cast).
    const flow = unvalidatedCliFlow({ expect: [] });

    expect(() => asCliFlow(flow)).not.toThrow();
  });

  it("rejects a value whose surface isn't actually 'cli'", () => {
    const malformed = unvalidatedWebFlow();

    expect(() => asCliFlow(malformed)).toThrow();
  });
});

describe("asWebFlow: runtime validation", () => {
  it("accepts a well-formed, already-validated web flow and returns it usable as WebFlowSpec", () => {
    const parsed = FlowSpecSchema.parse(unvalidatedWebFlow());
    const webFlow = asWebFlow(parsed);
    expect(webFlow.surface).toBe("web");
    expect(webFlow.steps).toEqual([{ visit: "/home" }]);
    expect(webFlow.expect).toEqual([{ visible: "Hello" }]);
  });

  it("rejects a hand-built web-surface flow whose steps carry a cli verb, instead of silently casting it", () => {
    const malformed = unvalidatedWebFlow({
      steps: [{ run: "flowspec init" }],
    });

    expect(() => asWebFlow(malformed)).toThrow();
  });

  it("rejects a hand-built web-surface flow whose expect list carries a cli assertion", () => {
    const malformed = unvalidatedWebFlow({
      expect: [{ exit_code: 0 }],
    });

    expect(() => asWebFlow(malformed)).toThrow();
  });

  it("does not reject a web-surface flow with an empty expect list — that authoring floor is FlowSpecSchema's job, not this grammar check", () => {
    const flow = unvalidatedWebFlow({ expect: [] });

    expect(() => asWebFlow(flow)).not.toThrow();
  });

  it("rejects a value whose surface isn't actually 'web'", () => {
    const malformed = unvalidatedCliFlow();

    expect(() => asWebFlow(malformed)).toThrow();
  });

  /**
   * CodeRabbit review comment (this PR, src/types.ts ~745-748): asWebFlow's
   * body was `WebFlowSpecSchema.parse(flow); return flow as WebFlowSpec;` —
   * running the parse purely for its throwing side effect and then returning
   * the ORIGINAL `flow`, discarding the parsed value entirely. That parsed
   * value is exactly where WebFlowSpecSchema's `surface:
   * SurfaceSchema.optional().default("web")` lives: for a hand-built flow
   * that never had a `surface` key at all, the schema parses successfully
   * (the default fills it in on the PARSED object), but the returned object
   * — being the untouched input — still has `surface === undefined` at
   * runtime, while WebFlowSpec's type says `surface: "web"`. That's a type
   * lie a caller could act on (e.g. a `flow.surface === "web"` check failing
   * on a value TypeScript insists is web-surface).
   */
  it('returns surface "web" for a hand-built flow whose surface key is omitted entirely, not surface: undefined', () => {
    const { surface: _omitted, ...withoutSurface } = unvalidatedWebFlow();
    const flow = withoutSurface as unknown as FlowSpec;

    const webFlow = asWebFlow(flow);

    expect(webFlow.surface).toBe("web");
  });

  /**
   * Guards the approach chosen to fix the bug above: whichever way asWebFlow
   * comes to guarantee `surface === "web"` on its return value, it must not
   * do so by re-parsing through a schema that silently strips fields
   * WebFlowSpecSchema doesn't itself declare. WebFlowSpecSchema declares
   * exactly FlowSpec's five fields (name, description, surface, setup,
   * steps, expect) — the same set FlowSpec itself has — so a well-formed
   * flow's own fields must all survive the round trip through asWebFlow.
   */
  it("preserves setup and all other fields through the surface narrowing", () => {
    const flow = unvalidatedWebFlow({
      setup: [{ visit: "/login" }],
    });

    const webFlow = asWebFlow(flow);

    expect(webFlow.setup).toEqual([{ visit: "/login" }]);
    expect(webFlow.name).toBe("web-flow");
    expect(webFlow.description).toBe("A web flow");
    expect(webFlow.steps).toEqual([{ visit: "/home" }]);
    expect(webFlow.expect).toEqual([{ visible: "Hello" }]);
  });
});
