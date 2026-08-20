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
 * Discriminates which step grammar a flow's steps/setup/expect must conform
 * to. "web" (the default) is the existing browser-driven verb family
 * (visit/click/fill/select/wait_for). "cli" is the command-line adapter:
 * run steps executed as subprocesses instead of browser actions.
 */
export const SurfaceSchema = z.enum(["web", "cli"]);

export type Surface = z.infer<typeof SurfaceSchema>;

/**
 * Schema for a CLI run step: executes a command and optionally checks its
 * result. `run` accepts either a single command string or an argv array.
 * Unknown keys are rejected by name via `.strict()`.
 */
export const CliStepSchema = z
  .object({
    run: z.union([z.string(), z.array(z.string())]),
    stdin: z.string().optional(),
    env: z.record(z.string()).optional(),
    timeout: z.number().positive().optional(),
    expect_exit: z.number().int().optional(),
  })
  .strict();

export type CliStep = z.infer<typeof CliStepSchema>;

function compilesAsRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every string-valued assertion payload is non-empty by construction.
 *
 * An empty needle, pattern, or path is not a weaker assertion — it is a
 * vacuous one: `"".includes("")` is true, an empty regex matches every
 * string, and an empty path resolves to the working directory itself. A spec
 * carrying one reports green while checking nothing, which is worse than no
 * assertion at all, so it is rejected at parse time.
 */
function nonEmptyString(field: string): z.ZodString {
  return z.string().min(1, `${field} must not be empty`);
}

// CLI assertion schemas - each is a distinct object shape, matching the
// .strict() convention of the web assertion schemas above.
const ExitCodeAssertionSchema = z
  .object({ exit_code: z.number().int() })
  .strict();
const StdoutContainsAssertionSchema = z
  .object({ stdout_contains: nonEmptyString("stdout_contains") })
  .strict();
const StderrContainsAssertionSchema = z
  .object({ stderr_contains: nonEmptyString("stderr_contains") })
  .strict();
const FileExistsAssertionSchema = z
  .object({ file_exists: nonEmptyString("file_exists") })
  .strict();

/**
 * `stdout_matches`/`stderr_matches` must be a compilable regex, checked at
 * parse time (before any flow runs) via `.refine()` so an uncompilable
 * pattern is a schema-level error naming the pattern, not a runtime crash.
 */
const StdoutMatchesAssertionSchema = z
  .object({ stdout_matches: nonEmptyString("stdout_matches") })
  .strict()
  .refine(
    (value) => compilesAsRegex(value.stdout_matches),
    (value) => ({
      message: `Invalid regex pattern "${value.stdout_matches}" for stdout_matches`,
    }),
  );

const StderrMatchesAssertionSchema = z
  .object({ stderr_matches: nonEmptyString("stderr_matches") })
  .strict()
  .refine(
    (value) => compilesAsRegex(value.stderr_matches),
    (value) => ({
      message: `Invalid regex pattern "${value.stderr_matches}" for stderr_matches`,
    }),
  );

/**
 * Compound assertions (`file_contains`, `json_output`) need a required-key
 * naming a missing sub-key explicitly. Zod's own "Required" message for a
 * missing field never names the field, and — because a missing key must
 * still let the base object parse succeed for the superRefine below to run
 * at all — each required sub-key is typed permissively (`.optional()` /
 * `z.unknown()`) at the base level, with real presence enforcement done here.
 */
const FileContainsAssertionSchema = z
  .object({
    file_contains: z
      .object({
        path: nonEmptyString("path").optional(),
        text: nonEmptyString("text").optional(),
      })
      .strict()
      .superRefine((value, ctx) => {
        if (value.path === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["path"],
            message: 'Missing required key "path" in file_contains',
          });
        }
        if (value.text === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["text"],
            message: 'Missing required key "text" in file_contains',
          });
        }
      }),
  })
  .strict();

/**
 * `equals` is deliberately `z.unknown()` (any expected value is valid), which
 * means Zod treats an entirely-absent "equals" key as satisfied — verified
 * interactively. `Object.hasOwn` against the parsed value is required to
 * actually detect absence; the parsed value only carries the key at all when
 * the input carried it (confirmed: Zod does not synthesize an
 * `equals: undefined` placeholder for a key that was never present).
 */
const JsonOutputAssertionSchema = z
  .object({
    json_output: z
      .object({ path: nonEmptyString("path").optional(), equals: z.unknown() })
      .strict()
      .superRefine((value, ctx) => {
        if (value.path === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["path"],
            message: 'Missing required key "path" in json_output',
          });
        }
        if (!Object.hasOwn(value, "equals")) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["equals"],
            message: 'Missing required key "equals" in json_output',
          });
        }
      }),
  })
  .strict();

/**
 * Schema for CLI assertions: exit_code, stdout_contains, stdout_matches,
 * stderr_contains, stderr_matches, file_exists, file_contains, json_output.
 */
export const CliAssertionSchema = z.union([
  ExitCodeAssertionSchema,
  StdoutContainsAssertionSchema,
  StdoutMatchesAssertionSchema,
  StderrContainsAssertionSchema,
  StderrMatchesAssertionSchema,
  FileExistsAssertionSchema,
  FileContainsAssertionSchema,
  JsonOutputAssertionSchema,
]);

export type CliAssertion = z.infer<typeof CliAssertionSchema>;

/** The CLI-surface assertion verbs — anything else is not a CLI assertion. */
const CLI_ASSERTION_VERBS = [
  "exit_code",
  "stdout_contains",
  "stdout_matches",
  "stderr_contains",
  "stderr_matches",
  "file_exists",
  "file_contains",
  "json_output",
] as const;

/** The web-surface assertion verbs — anything else is not a web assertion. */
const WEB_ASSERTION_VERBS = [
  "url",
  "visible",
  "matches",
  "not_visible",
] as const;

/**
 * Resolves a verb key directly to its own schema (rather than the surface's
 * whole union) so a structurally-matched-but-malformed assertion (e.g. a
 * `file_contains` missing `path`) surfaces that specific schema's own
 * message. Running the whole union instead would make every OTHER member
 * fail too (they don't have this assertion's key at all), and Zod's
 * invalid_union error swallows every member's specific message behind a
 * generic one.
 */
const CLI_ASSERTION_SCHEMAS: Record<string, z.ZodTypeAny> = {
  exit_code: ExitCodeAssertionSchema,
  stdout_contains: StdoutContainsAssertionSchema,
  stdout_matches: StdoutMatchesAssertionSchema,
  stderr_contains: StderrContainsAssertionSchema,
  stderr_matches: StderrMatchesAssertionSchema,
  file_exists: FileExistsAssertionSchema,
  file_contains: FileContainsAssertionSchema,
  json_output: JsonOutputAssertionSchema,
};

const WEB_ASSERTION_SCHEMAS: Record<string, z.ZodTypeAny> = {
  url: UrlAssertionSchema,
  visible: VisibleAssertionSchema,
  matches: MatchesAssertionSchema,
  not_visible: NotVisibleAssertionSchema,
};

/** The web-surface step verbs — anything else is not a web step. */
const WEB_STEP_VERBS = [
  "visit",
  "click",
  "fill",
  "select",
  "wait_for",
] as const;

/**
 * The key that names what a raw (not-yet-validated) step object is trying to
 * do, for use in a human-facing error message. `run` wins when present so a
 * CLI step with an invalid modifier still reports "run", not "stdin"/"env".
 */
function stepVerb(step: unknown): string {
  if (step && typeof step === "object" && !Array.isArray(step)) {
    const record = step as Record<string, unknown>;
    if ("run" in record) {
      return "run";
    }
    const [firstKey] = Object.keys(record);
    return firstKey ?? "unknown";
  }
  return "unknown";
}

function isCliVerbStep(step: unknown): boolean {
  return (
    !!step &&
    typeof step === "object" &&
    !Array.isArray(step) &&
    "run" in (step as Record<string, unknown>)
  );
}

function isWebVerbStep(step: unknown): boolean {
  return (
    !!step &&
    typeof step === "object" &&
    !Array.isArray(step) &&
    WEB_STEP_VERBS.some((verb) => verb in (step as Record<string, unknown>))
  );
}

/**
 * One specific problem found in a failed parse: Zod's own message, at the
 * path (relative to the value that was parsed) where it belongs.
 */
interface SchemaIssueDetail {
  path: (string | number)[];
  message: string;
}

/**
 * Unwrap Zod's generic union wrapper down to the issues that actually say
 * something.
 *
 * A union's top-level issue is always the useless "Invalid input"; the real
 * detail ("Expected string, received number") lives one level down, in
 * `unionErrors[branch].issues[]` — one branch per union member. Since the
 * verb the author was reaching for is already known, the branches that
 * recognize that verb as a field of their OWN are preferred: every other
 * branch failed merely because it has no such key at all, and its
 * "Unrecognized key(s)" complaint describes the schema, not the mistake.
 * When no branch recognizes the verb (an entirely unrelated shape), every
 * branch's issues are kept rather than reporting nothing.
 */
function flattenIssues(
  issues: readonly z.ZodIssue[],
  verb: string,
): SchemaIssueDetail[] {
  const details: SchemaIssueDetail[] = [];

  for (const issue of issues) {
    if (issue.code === z.ZodIssueCode.invalid_union) {
      const relevant = issue.unionErrors.filter((branch) =>
        branch.issues.some((branchIssue) => branchIssue.path[0] === verb),
      );
      const branches = relevant.length > 0 ? relevant : issue.unionErrors;
      details.push(
        ...flattenIssues(
          branches.flatMap((branch) => branch.issues),
          verb,
        ),
      );
      continue;
    }

    details.push({ path: [...issue.path], message: issue.message });
  }

  return details;
}

/** Distinct issues only: the same message at the same path is reported once. */
function detailsFromError(
  error: z.ZodError,
  verb: string,
): SchemaIssueDetail[] {
  const seen = new Set<string>();
  return flattenIssues(error.issues, verb).filter((detail) => {
    const key = `${detail.path.join(".")} ${detail.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * Push every specific problem `value` has against `schema` as its own issue,
 * each located at `basePath` + the field within `value` that carries it — so
 * two different malformed sub-fields of the same step produce two different,
 * individually-located errors instead of the identical generic message both
 * used to get.
 *
 * Shared by the flow-level step/assertion validation below and by the
 * config-level setup validation in src/config.ts, which had the same gap.
 *
 * A no-op when `value` actually parses. If a failure somehow yields no
 * detail at all, Zod's own joined messages are reported at `basePath` rather
 * than nothing, so a malformed value can never slip through silently.
 */
export function addSchemaFailureIssues(
  schema: z.ZodTypeAny,
  value: unknown,
  verb: string,
  basePath: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  const result = schema.safeParse(value);
  if (result.success) {
    return;
  }

  const details = detailsFromError(result.error, verb);
  if (details.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: basePath,
      message: result.error.issues.map((issue) => issue.message).join("; "),
    });
    return;
  }

  for (const detail of details) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...basePath, ...detail.path],
      message: detail.message,
    });
  }
}

/**
 * Re-validates a single steps/setup entry against the grammar for the flow's
 * resolved surface, pushing a custom issue when it doesn't conform.
 *
 * The base `steps`/`setup` field type (see FlowSpecSchema) is deliberately
 * permissive so that both the web and CLI grammars parse structurally at
 * that level — enforcement happens entirely here, so a mismatch is reported
 * with the actual offending verb and surface, and a same-surface structural
 * problem (an unrecognized key, a bad value type) surfaces Zod's own
 * message naming it, rather than a generic "no union member matched" error.
 */
function validateStepForSurface(
  step: unknown,
  surface: Surface,
  path: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  const matchesVerbFamily =
    surface === "cli" ? isCliVerbStep(step) : isWebVerbStep(step);

  if (!matchesVerbFamily) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `Step verb "${stepVerb(step)}" is not valid for surface "${surface}"`,
    });
    return;
  }

  const schema = surface === "cli" ? CliStepSchema : FlowStepSchema;
  // The verb this step was reaching for, checked against the known set
  // rather than taken as "whatever key came first" — it selects which union
  // branch's issues actually describe the mistake (see flattenIssues).
  const verb =
    surface === "cli"
      ? "run"
      : (matchedVerb(step, WEB_STEP_VERBS) ?? stepVerb(step));
  addSchemaFailureIssues(schema, step, verb, path, ctx);
}

function validateStepsForSurface(
  steps: unknown,
  surface: Surface,
  field: "steps" | "setup",
  ctx: z.RefinementCtx,
): void {
  if (!Array.isArray(steps)) {
    return;
  }
  steps.forEach((step, index) => {
    validateStepForSurface(step, surface, [field, index], ctx);
  });
}

/**
 * The key that names what a raw (not-yet-validated) assertion object is
 * trying to check, for use in a human-facing error message.
 */
function assertionVerb(assertion: unknown): string {
  if (assertion && typeof assertion === "object" && !Array.isArray(assertion)) {
    const [firstKey] = Object.keys(assertion as Record<string, unknown>);
    return firstKey ?? "unknown";
  }
  return "unknown";
}

/** The first of `verbs` present as a key on `assertion`, if any. */
function matchedVerb(
  assertion: unknown,
  verbs: readonly string[],
): string | undefined {
  if (!assertion || typeof assertion !== "object" || Array.isArray(assertion)) {
    return undefined;
  }
  const record = assertion as Record<string, unknown>;
  return verbs.find((verb) => verb in record);
}

/**
 * Re-validates a single expect-list entry against the assertion vocabulary
 * for the flow's resolved surface, mirroring `validateStepForSurface`: a
 * verb from the wrong surface's family is a mismatch naming the verb and
 * surface, while a same-surface structural problem (missing sub-key, extra
 * key, uncompilable regex) surfaces that specific assertion schema's own
 * message.
 */
function validateAssertionForSurface(
  assertion: unknown,
  surface: Surface,
  index: number,
  ctx: z.RefinementCtx,
): void {
  const verbs = surface === "cli" ? CLI_ASSERTION_VERBS : WEB_ASSERTION_VERBS;
  const schemas =
    surface === "cli" ? CLI_ASSERTION_SCHEMAS : WEB_ASSERTION_SCHEMAS;
  const verb = matchedVerb(assertion, verbs);
  const path = ["expect", index];

  if (!verb) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `Assertion "${assertionVerb(assertion)}" is not valid for surface "${surface}"`,
    });
    return;
  }

  addSchemaFailureIssues(schemas[verb], assertion, verb, path, ctx);
}

function validateExpectForSurface(
  expectList: unknown,
  surface: Surface,
  ctx: z.RefinementCtx,
): void {
  if (!Array.isArray(expectList)) {
    return;
  }
  expectList.forEach((assertion, index) => {
    validateAssertionForSurface(assertion, surface, index, ctx);
  });
}

/**
 * Schema for a complete flow specification
 * Defines a user flow with steps to execute and assertions to verify
 *
 * `surface` selects the step/assertion grammar: absent or "web" keeps
 * today's browser-driven behavior byte-identical; "cli" switches
 * steps/setup/expect to the CLI vocabulary (run steps, exit_code/
 * stdout_contains/etc. assertions).
 *
 * `steps`/`setup`/`expect` carry the union of both surfaces' element types.
 * The element schema is `z.custom` — runtime-permissive, exactly as the
 * previous `z.any()` was — because the real verb/shape enforcement lives in
 * the superRefine below, keyed off the resolved surface, and Zod skips a
 * refinement entirely when the object it wraps already failed to parse.
 * Binding these fields to a real `z.union([...])` would therefore trade
 * every specific, surface-aware error message ("Step verb \"click\" is not
 * valid for surface \"cli\"") for the generic "Invalid input" a union
 * failure reports. What `z.custom` restores over `z.any()` is the
 * COMPILE-time guarantee: `FlowSpec["steps"]` is a real union again, not
 * `any[]`, so a bogus property chain on a step is a type error at every
 * call site.
 */
export const FlowSpecSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    surface: SurfaceSchema.optional().default("web"),
    setup: z.array(z.custom<FlowStep | CliStep>()).optional(),
    steps: z.array(z.custom<FlowStep | CliStep>()).min(1),
    expect: z.array(z.custom<StepAssertion | CliAssertion>()),
  })
  .superRefine((flow, ctx) => {
    const { surface } = flow;

    validateStepsForSurface(flow.steps, surface, "steps", ctx);
    if (flow.setup) {
      validateStepsForSurface(flow.setup, surface, "setup", ctx);
    }

    // Both surfaces: a flow whose expect list is empty asserts nothing, and
    // its assertion loop passes trivially. The web surface has always
    // required at least one; the CLI surface needs the same floor for the
    // same reason.
    if (flow.expect.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expect"],
        message: `expect must contain at least one assertion for surface ${surface}`,
      });
    } else {
      validateExpectForSurface(flow.expect, surface, ctx);
    }
  });

export type FlowSpec = z.infer<typeof FlowSpecSchema>;

/**
 * A FlowSpec already known to be CLI-surface: its steps, setup and
 * assertions are the CLI vocabulary, not the union of both surfaces.
 *
 * This is what the CLI runner takes, so it never has to cast its way from
 * "some step" to "a run step" element by element.
 */
export type CliFlowSpec = Omit<
  FlowSpec,
  "surface" | "setup" | "steps" | "expect"
> & {
  surface: "cli";
  setup?: CliStep[];
  steps: CliStep[];
  expect: CliAssertion[];
};

/**
 * A FlowSpec already known to be web-surface: the browser-driven step and
 * assertion vocabulary, with no CLI members mixed in.
 */
export type WebFlowSpec = Omit<
  FlowSpec,
  "surface" | "setup" | "steps" | "expect"
> & {
  surface: "web";
  setup?: FlowStep[];
  steps: FlowStep[];
  expect: StepAssertion[];
};

/**
 * Narrow a flow to one surface's vocabulary, at the ONE place the surface is
 * dispatched on (src/runner.ts's runFlow).
 *
 * FlowSpecSchema's superRefine already rejects, at parse time, any flow
 * whose steps/setup/expect don't match its declared surface — so for a
 * parsed flow these restate a guarantee the schema has enforced. They are
 * assertions rather than predicates because `surface` cannot narrow the
 * object it sits on (FlowSpec is one object type, not a discriminated
 * union). Keeping them as two named, documented calls at the dispatch point
 * means a caller that hand-builds an unvalidated flow has exactly one place
 * to have gone wrong, instead of an unchecked `as CliStep[]` at every use
 * site downstream.
 */
export function asCliFlow(flow: FlowSpec): CliFlowSpec {
  return flow as CliFlowSpec;
}

export function asWebFlow(flow: FlowSpec): WebFlowSpec {
  return flow as WebFlowSpec;
}

/**
 * Schema for flow execution errors
 * Can describe either a step failure or an assertion failure
 *
 * `phase` marks a failure that happened outside the flow's own steps:
 * - "setup" - a shared setup step failed
 * - "headers" - applying config-level HTTP headers to the browser session
 *   failed, before any step ran (so no step/action accompanies it)
 *
 * `exitCode`/`stdout`/`stderr`/`workdir` are the CLI analogs of `screenshot`:
 * populated by a CLI flow's failure, left absent for a web flow's (and vice
 * versa — `screenshot` is simply never set for a CLI failure).
 */
export const FlowErrorSchema = z.object({
  message: z.string(),
  phase: z.enum(["setup", "headers"]).optional(),
  step: z.number().optional(),
  action: z.union([StepActionSchema, CliStepSchema]).optional(),
  assertion: StepAssertionSchema.optional(),
  screenshot: z.string().optional(),
  exitCode: z.number().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  workdir: z.string().optional(),
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
