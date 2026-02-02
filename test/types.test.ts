import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  FlowErrorSchema,
  FlowResultSchema,
  FlowSpecSchema,
  StepActionSchema,
  StepAssertionSchema,
} from "../src/types";

describe("FlowSpec Types", () => {
  it("should export all required Zod schemas", () => {
    expect(FlowSpecSchema instanceof z.ZodType).toBe(true);
    expect(StepActionSchema instanceof z.ZodType).toBe(true);
    expect(StepAssertionSchema instanceof z.ZodType).toBe(true);
    expect(FlowResultSchema instanceof z.ZodType).toBe(true);
    expect(FlowErrorSchema instanceof z.ZodType).toBe(true);
  });

  it("StepAction should validate visit, click, fill, and select", () => {
    expect(StepActionSchema.safeParse({ visit: "/login" }).success).toBe(true);
    expect(StepActionSchema.safeParse({ click: "Submit" }).success).toBe(true);
    expect(
      StepActionSchema.safeParse({ fill: { Email: "test@example.com" } })
        .success,
    ).toBe(true);
    expect(
      StepActionSchema.safeParse({ select: { Country: "US" } }).success,
    ).toBe(true);
    expect(StepActionSchema.safeParse({}).success).toBe(false);
  });

  it("StepAssertion should validate url, visible, matches, and not_visible", () => {
    expect(StepAssertionSchema.safeParse({ url: "/dashboard" }).success).toBe(
      true,
    );
    expect(StepAssertionSchema.safeParse({ visible: "Welcome" }).success).toBe(
      true,
    );
    expect(
      StepAssertionSchema.safeParse({ matches: "Order #\\d+" }).success,
    ).toBe(true);
    expect(
      StepAssertionSchema.safeParse({ not_visible: "Error" }).success,
    ).toBe(true);
    expect(StepAssertionSchema.safeParse({}).success).toBe(false);
  });

  it("FlowSpec should validate complete flow with required fields", () => {
    const validFlow = {
      name: "user-login",
      description: "User can log in",
      steps: [
        { visit: "/login" },
        { fill: { Email: "user@test.com", Password: "pass" } },
        { click: "Sign In" },
      ],
      expect: [{ url: "/dashboard" }, { visible: "Welcome" }],
    };
    expect(FlowSpecSchema.safeParse(validFlow).success).toBe(true);

    // Missing required fields should fail
    expect(FlowSpecSchema.safeParse({ name: "test" }).success).toBe(false);
    expect(
      FlowSpecSchema.safeParse({ name: "test", description: "test", steps: [] })
        .success,
    ).toBe(false);
  });

  it("FlowResult should validate success and failure cases", () => {
    const success = { success: true, flowName: "test", duration: 100 };
    expect(FlowResultSchema.safeParse(success).success).toBe(true);

    const failure = {
      success: false,
      flowName: "test",
      duration: 100,
      error: { message: "Failed", step: 1 },
    };
    expect(FlowResultSchema.safeParse(failure).success).toBe(true);

    expect(FlowResultSchema.safeParse({ success: true }).success).toBe(false);
  });

  it("FlowError should validate error with message", () => {
    const error = {
      message: "Element not found",
      step: 2,
      action: { click: "Submit" },
    };
    expect(FlowErrorSchema.safeParse(error).success).toBe(true);

    expect(FlowErrorSchema.safeParse({}).success).toBe(false);
  });
});
