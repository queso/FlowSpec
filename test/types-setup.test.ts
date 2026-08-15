import { describe, expect, it } from "vitest";
import { parseFlowSpec } from "../src/parser";
import {
  FlowErrorSchema,
  FlowResultSchema,
  FlowSpecSchema,
} from "../src/types";

/**
 * Tests for WI-767: setup block, error phase, and skipped result state.
 *
 * Contract pinned by the work item:
 *  - setup: z.array(FlowStepSchema).optional() on FlowSpecSchema
 *  - FlowErrorSchema.phase: z.literal("setup").optional()
 *  - FlowResultSchema.skipped: z.boolean().optional()
 */

const baseFlow = {
  name: "test-flow",
  description: "Test flow",
  steps: [{ visit: "/home" }],
  expect: [{ visible: "Hello" }],
};

describe("FlowSpecSchema setup field", () => {
  it("parses a top-level setup list of valid steps, in order", () => {
    const yamlContent = `
name: test-flow
description: Test
setup:
  - visit: /login
  - fill:
      Email: admin@example.com
steps:
  - visit: /home
expect:
  - visible: Hello
`;
    const result = parseFlowSpec(yamlContent);
    expect(result.setup).toEqual([
      { visit: "/login" },
      { fill: { Email: "admin@example.com" } },
    ]);
  });

  it("distinguishes setup: [] (empty array) from setup being absent (undefined)", () => {
    const withEmptySetup = FlowSpecSchema.safeParse({
      ...baseFlow,
      setup: [],
    });
    expect(withEmptySetup.success).toBe(true);
    if (withEmptySetup.success) {
      expect(withEmptySetup.data.setup).toEqual([]);
    }

    const withoutSetup = FlowSpecSchema.safeParse(baseFlow);
    expect(withoutSetup.success).toBe(true);
    if (withoutSetup.success) {
      expect(withoutSetup.data.setup).toBeUndefined();
    }
    // The two outcomes must be distinguishable from one another.
    expect(
      withEmptySetup.success && withEmptySetup.data.setup,
    ).not.toStrictEqual(withoutSetup.success && withoutSetup.data.setup);
  });

  it("rejects a malformed step in setup (extra key), naming the setup path", () => {
    const result = FlowSpecSchema.safeParse({
      ...baseFlow,
      setup: [{ visit: "/home", extra: "field" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path[0]).toBe("setup");
      expect(result.error.issues[0].path[1]).toBe(0);
    }
  });

  it("rejects an unknown action in setup, naming the setup path", () => {
    const result = FlowSpecSchema.safeParse({
      ...baseFlow,
      setup: [{ unknown_action: "value" }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path[0]).toBe("setup");
    }
  });

  it("uses the same error-path shape for a malformed step in setup as for one in steps", () => {
    const setupResult = FlowSpecSchema.safeParse({
      ...baseFlow,
      setup: [{ visit: "/home", extra: "field" }],
    });
    const stepsResult = FlowSpecSchema.safeParse({
      ...baseFlow,
      steps: [{ visit: "/home", extra: "field" }],
    });
    expect(setupResult.success).toBe(false);
    expect(stepsResult.success).toBe(false);
    if (!setupResult.success && !stepsResult.success) {
      expect(setupResult.error.issues[0].path[0]).toBe("setup");
      expect(stepsResult.error.issues[0].path[0]).toBe("steps");
      // Same shape (index + inner issue) once the container-key element is dropped.
      expect(setupResult.error.issues[0].path.slice(1)).toEqual(
        stepsResult.error.issues[0].path.slice(1),
      );
      expect(setupResult.error.issues[0].code).toEqual(
        stepsResult.error.issues[0].code,
      );
    }
  });

  it("still requires steps and expect to be present and non-empty when setup is provided", () => {
    const result = FlowSpecSchema.safeParse({
      name: "test",
      description: "test",
      setup: [{ visit: "/login" }],
      steps: [],
      expect: [{ visible: "Hello" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("FlowErrorSchema phase field", () => {
  it("accepts phase: 'setup'", () => {
    const result = FlowErrorSchema.safeParse({
      message: "Setup step failed",
      phase: "setup",
      step: 0,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phase).toBe("setup");
    }
  });

  it("parses unchanged when phase is absent (step still refers to flow.steps)", () => {
    const result = FlowErrorSchema.safeParse({
      message: "Element not found",
      step: 2,
      action: { click: "Submit" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phase).toBeUndefined();
      expect(result.data.step).toBe(2);
    }
  });

  it("rejects any phase value other than the literal 'setup'", () => {
    const wrongLiteral = FlowErrorSchema.safeParse({
      message: "failed",
      phase: "steps",
    });
    expect(wrongLiteral.success).toBe(false);

    const wrongType = FlowErrorSchema.safeParse({
      message: "failed",
      phase: true,
    });
    expect(wrongType.success).toBe(false);
  });
});

describe("FlowResultSchema skipped field", () => {
  it("accepts a skipped flow represented as success: false, skipped: true", () => {
    const result = FlowResultSchema.safeParse({
      success: false,
      flowName: "test",
      duration: 0,
      skipped: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.success).toBe(false);
      expect(result.data.skipped).toBe(true);
    }
  });

  it("parses unchanged when skipped is absent, so every existing result shape stays valid", () => {
    const success = FlowResultSchema.safeParse({
      success: true,
      flowName: "test",
      duration: 100,
    });
    expect(success.success).toBe(true);
    if (success.success) {
      expect(success.data.skipped).toBeUndefined();
    }

    const failure = FlowResultSchema.safeParse({
      success: false,
      flowName: "test",
      duration: 100,
      error: { message: "Failed", step: 1 },
    });
    expect(failure.success).toBe(true);
    if (failure.success) {
      expect(failure.data.skipped).toBeUndefined();
    }
  });

  it("rejects a non-boolean skipped value", () => {
    const result = FlowResultSchema.safeParse({
      success: false,
      flowName: "test",
      duration: 0,
      skipped: "yes",
    });
    expect(result.success).toBe(false);
  });

  it("does not introduce a status enum: an unrecognized status-like key is not required or validated", () => {
    // FlowResultSchema is intentionally non-strict; skipped is the only new
    // signal for "flow never ran," not a parallel status field.
    const result = FlowResultSchema.safeParse({
      success: false,
      flowName: "test",
      duration: 0,
      skipped: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect("status" in result.data).toBe(false);
    }
  });

  it("rejects the contradictory success: true, skipped: true, naming the contradiction", () => {
    const result = FlowResultSchema.safeParse({
      success: true,
      flowName: "test",
      duration: 100,
      skipped: true,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(
        /skipped flow cannot be successful/i,
      );
    }
  });

  it("still parses success: false, skipped: true (the valid skipped shape)", () => {
    const result = FlowResultSchema.safeParse({
      success: false,
      flowName: "test",
      duration: 0,
      skipped: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.success).toBe(false);
      expect(result.data.skipped).toBe(true);
    }
  });

  it("still parses success: true with skipped absent or skipped: false (only true+true is contradictory)", () => {
    const withoutSkipped = FlowResultSchema.safeParse({
      success: true,
      flowName: "test",
      duration: 100,
    });
    expect(withoutSkipped.success).toBe(true);

    const withSkippedFalse = FlowResultSchema.safeParse({
      success: true,
      flowName: "test",
      duration: 100,
      skipped: false,
    });
    expect(withSkippedFalse.success).toBe(true);
    if (withSkippedFalse.success) {
      expect(withSkippedFalse.data.skipped).toBe(false);
    }
  });
});
