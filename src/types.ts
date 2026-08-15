import { z } from "zod";

// Action schemas - each action type is a distinct object shape
const VisitActionSchema = z.object({ visit: z.string() }).strict();
const ClickActionSchema = z.object({ click: z.string() }).strict();
const FillActionSchema = z.object({ fill: z.record(z.string()) }).strict();
const SelectActionSchema = z.object({ select: z.record(z.string()) }).strict();
const WaitForActionSchema = z.object({ wait_for: z.string() }).strict();

/**
 * Schema for step actions: visit, click, fill, select, wait_for
 * Uses discriminated union to ensure exactly one action type per step
 */
export const StepActionSchema = z.union([
  VisitActionSchema,
  ClickActionSchema,
  FillActionSchema,
  SelectActionSchema,
  WaitForActionSchema,
]);

export type StepAction = z.infer<typeof StepActionSchema>;

/**
 * Type guard for wait_for action
 */
export function isWaitForAction(
  action: StepAction,
): action is { wait_for: string } {
  return "wait_for" in action;
}

// Assertion schemas - each assertion type is a distinct object shape
const UrlAssertionSchema = z.object({ url: z.string() }).strict();
const VisibleAssertionSchema = z.object({ visible: z.string() }).strict();
const MatchesAssertionSchema = z.object({ matches: z.string() }).strict();
const NotVisibleAssertionSchema = z
  .object({ not_visible: z.string() })
  .strict();

/**
 * Schema for step assertions: url, visible, matches, not_visible
 * Uses discriminated union to ensure exactly one assertion type
 */
export const StepAssertionSchema = z.union([
  UrlAssertionSchema,
  VisibleAssertionSchema,
  MatchesAssertionSchema,
  NotVisibleAssertionSchema,
]);

export type StepAssertion = z.infer<typeof StepAssertionSchema>;

/**
 * Schema for a flow step - currently identical to StepAction
 * A step in a flow is simply an action to perform
 */
export const FlowStepSchema = StepActionSchema;

export type FlowStep = z.infer<typeof FlowStepSchema>;

/**
 * Schema for a complete flow specification
 * Defines a user flow with steps to execute and assertions to verify
 */
export const FlowSpecSchema = z.object({
  name: z.string(),
  description: z.string(),
  setup: z.array(FlowStepSchema).optional(),
  steps: z.array(FlowStepSchema).min(1),
  expect: z.array(StepAssertionSchema).min(1),
});

export type FlowSpec = z.infer<typeof FlowSpecSchema>;

/**
 * Schema for flow execution errors
 * Can describe either a step failure or an assertion failure
 *
 * `phase` marks a failure that happened outside the flow's own steps:
 * - "setup" - a shared setup step failed
 * - "headers" - applying config-level HTTP headers to the browser session
 *   failed, before any step ran (so no step/action accompanies it)
 */
export const FlowErrorSchema = z.object({
  message: z.string(),
  phase: z.enum(["setup", "headers"]).optional(),
  step: z.number().optional(),
  action: StepActionSchema.optional(),
  assertion: StepAssertionSchema.optional(),
  screenshot: z.string().optional(),
});

export type FlowError = z.infer<typeof FlowErrorSchema>;

/**
 * Schema for flow execution results
 * Contains success status, timing, and optional error details
 */
export const FlowResultSchema = z
  .object({
    success: z.boolean(),
    flowName: z.string(),
    duration: z.number(),
    error: FlowErrorSchema.optional(),
    skipped: z.boolean().optional(),
  })
  .refine((result) => !(result.success && result.skipped === true), {
    message:
      "a skipped flow cannot be successful (success: true, skipped: true is contradictory)",
    path: ["skipped"],
  });

export type FlowResult = z.infer<typeof FlowResultSchema>;
