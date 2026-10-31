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
 * run steps executed as subprocesses instead of browser actions. "api" is
 * the HTTP adapter: request steps sent with fetch, each with its own
 * assertions and captures.
 */
export const SurfaceSchema = z.enum(["web", "cli", "api"]);

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

/**
 * Resolves a verb key directly to its own schema (rather than the surface's
 * whole union) so a structurally-matched-but-malformed assertion (e.g. a
 * `file_contains` missing `path`) surfaces that specific schema's own
 * message. Running the whole union instead would make every OTHER member
 * fail too (they don't have this assertion's key at all), and Zod's
 * invalid_union error swallows every member's specific message behind a
 * generic one.
 *
 * This is the single source of truth for the CLI assertion vocabulary:
 * CLI_ASSERTION_VERBS below is derived from its keys rather than listed
 * separately, so a verb added here can never drift out of sync with the
 * verbs `validateAssertionForSurface` recognizes.
 */
const CLI_ASSERTION_SCHEMAS = {
  exit_code: ExitCodeAssertionSchema,
  stdout_contains: StdoutContainsAssertionSchema,
  stdout_matches: StdoutMatchesAssertionSchema,
  stderr_contains: StderrContainsAssertionSchema,
  stderr_matches: StderrMatchesAssertionSchema,
  file_exists: FileExistsAssertionSchema,
  file_contains: FileContainsAssertionSchema,
  json_output: JsonOutputAssertionSchema,
} satisfies Record<string, z.ZodTypeAny>;

/** The CLI-surface assertion verbs — anything else is not a CLI assertion. */
const CLI_ASSERTION_VERBS = Object.keys(
  CLI_ASSERTION_SCHEMAS,
) as (keyof typeof CLI_ASSERTION_SCHEMAS)[];

/**
 * A flow variable name, as used by `{name}` templates and `capture` keys.
 * Exported so src/api-template.ts recognizes exactly the names a capture
 * can define.
 */
export const VARIABLE_NAME_PATTERN = "[A-Za-z_][A-Za-z0-9_]*";
const VARIABLE_NAME_REGEX = new RegExp(`^${VARIABLE_NAME_PATTERN}$`);

/** The HTTP methods an api `request` can name, one per request. */
export const API_METHODS = [
  "get",
  "head",
  "post",
  "put",
  "patch",
  "delete",
] as const;

export type ApiMethod = (typeof API_METHODS)[number];

/** Methods whose requests the runner may re-send while polling. */
export const RETRYABLE_API_METHODS: readonly ApiMethod[] = ["get", "head"];

/** The method key present on a raw request object, if exactly one is. */
export function requestMethod(request: unknown): ApiMethod | undefined {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return undefined;
  }
  const present = API_METHODS.filter((method) =>
    Object.hasOwn(request as Record<string, unknown>, method),
  );
  return present.length === 1 ? present[0] : undefined;
}

/** A header or query value: YAML scalars are accepted and sent as strings. */
const ApiScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

const methodFields = Object.fromEntries(
  API_METHODS.map((method) => [method, nonEmptyString(method).optional()]),
) as Record<ApiMethod, z.ZodOptional<z.ZodString>>;

/**
 * Schema for the `request` block of an api step: exactly one method key
 * whose value is a path or absolute URL, plus optional headers, query, and
 * one of `json` or `body`.
 */
export const ApiRequestSchema = z
  .object({
    ...methodFields,
    headers: z.record(ApiScalarSchema).optional(),
    query: z.record(ApiScalarSchema).optional(),
    json: z.unknown().optional(),
    body: z.string().optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    const method = requestMethod(request);
    if (!method) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: `request must have exactly one method key (${API_METHODS.join(", ")})`,
      });
      return;
    }

    // `json: null` is a real body (the JSON document "null"), so presence
    // is checked by key, not by value.
    const hasJson = Object.hasOwn(request, "json");
    const hasBody = request.body !== undefined;
    if (hasJson && hasBody) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: "request may have json or body, not both",
      });
    }
    if ((hasJson || hasBody) && RETRYABLE_API_METHODS.includes(method)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasJson ? "json" : "body"],
        message: `a ${method} request cannot have a body`,
      });
    }
  });

export type ApiRequest = z.infer<typeof ApiRequestSchema>;

/**
 * `capture` maps a variable name to a JSONPath, or to `{path, secret}` for
 * a value that must be redacted from output.
 */
const ApiCaptureSchema = z
  .record(
    z.union([
      nonEmptyString("capture path"),
      z
        .object({
          path: nonEmptyString("capture path"),
          secret: z.boolean().optional(),
        })
        .strict(),
    ]),
  )
  .superRefine((capture, ctx) => {
    for (const name of Object.keys(capture)) {
      if (!VARIABLE_NAME_REGEX.test(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `capture name "${name}" must match ${VARIABLE_NAME_PATTERN}`,
        });
      }
    }
  });

export type ApiCapture = z.infer<typeof ApiCaptureSchema>;

const StatusAssertionSchema = z
  .object({ status: z.number().int().min(100).max(599) })
  .strict();

const LatencyUnderAssertionSchema = z
  .object({ latency_under: z.number().positive() })
  .strict();

/** The comparison keys of a `json` assertion; exactly one must be present. */
const JSON_COMPARISONS = ["equals", "in", "matches", "exists"] as const;

/**
 * `equals` is `z.unknown()` for the same reason json_output's is (any
 * expected value is valid, `null` included), so presence is checked with
 * `Object.hasOwn` rather than by value.
 */
const ApiJsonAssertionSchema = z
  .object({
    json: z
      .object({
        path: nonEmptyString("path").optional(),
        equals: z.unknown(),
        in: z
          .array(z.unknown())
          .min(1, "in must list at least one value")
          .optional(),
        matches: nonEmptyString("matches").optional(),
        exists: z.boolean().optional(),
      })
      .strict()
      .superRefine((value, ctx) => {
        if (value.path === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["path"],
            message: 'Missing required key "path" in json',
          });
        }
        const present = JSON_COMPARISONS.filter((key) =>
          Object.hasOwn(value, key),
        );
        if (present.length !== 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [],
            message: `json assertion needs exactly one of ${JSON_COMPARISONS.join(", ")}`,
          });
        }
        if (value.matches !== undefined && !compilesAsRegex(value.matches)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["matches"],
            message: `Invalid regex pattern "${value.matches}" for json.matches`,
          });
        }
      }),
  })
  .strict();

const ApiHeaderAssertionSchema = z
  .object({
    header: z
      .object({
        name: nonEmptyString("name"),
        equals: z.string().optional(),
        contains: nonEmptyString("contains").optional(),
      })
      .strict()
      .superRefine((value, ctx) => {
        const present = (["equals", "contains"] as const).filter(
          (key) => value[key] !== undefined,
        );
        if (present.length !== 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [],
            message: "header assertion needs exactly one of equals, contains",
          });
        }
      }),
  })
  .strict();

/**
 * Schema for api assertions: status, json, header, latency_under. Used both
 * in a request step's own `expect` and in a flow-level `expect`.
 */
export const ApiAssertionSchema = z.union([
  StatusAssertionSchema,
  ApiJsonAssertionSchema,
  ApiHeaderAssertionSchema,
  LatencyUnderAssertionSchema,
]);

export type ApiAssertion = z.infer<typeof ApiAssertionSchema>;

/** Single source of truth for the api assertion vocabulary. */
const API_ASSERTION_SCHEMAS = {
  status: StatusAssertionSchema,
  json: ApiJsonAssertionSchema,
  header: ApiHeaderAssertionSchema,
  latency_under: LatencyUnderAssertionSchema,
} satisfies Record<string, z.ZodTypeAny>;

const API_ASSERTION_VERBS = Object.keys(
  API_ASSERTION_SCHEMAS,
) as (keyof typeof API_ASSERTION_SCHEMAS)[];

/**
 * The structural shape of a request step. `expect` entries are checked one
 * by one against the api assertion vocabulary (see validateApiStep) so a
 * wrong-surface assertion is named; `timeout` is a non-negative retry budget
 * whose method restriction is also checked there.
 */
const ApiRequestStepShape = z
  .object({
    request: ApiRequestSchema,
    capture: ApiCaptureSchema.optional(),
    expect: z.array(z.unknown()).optional(),
    timeout: z.number().int().nonnegative().optional(),
  })
  .strict();

/** A `wait: <ms>` step: sleeps, sends nothing. */
export const ApiWaitStepSchema = z
  .object({ wait: z.number().nonnegative() })
  .strict();

export type ApiWaitStep = z.infer<typeof ApiWaitStepSchema>;

/** The method restriction on a request step's `timeout`. */
function timeoutMethodIssue(step: {
  request: unknown;
  timeout?: number;
}): string | undefined {
  const method = requestMethod(step.request);
  if (
    step.timeout === undefined ||
    method === undefined ||
    RETRYABLE_API_METHODS.includes(method)
  ) {
    return undefined;
  }
  return `timeout is only valid on GET and HEAD steps (this step is ${method.toUpperCase()}, which is sent once and never retried)`;
}

/**
 * The fully typed request step, used by asApiFlow's confirming re-parse.
 * Error reporting for spec authors goes through validateApiStep instead.
 */
export const ApiRequestStepSchema = ApiRequestStepShape.extend({
  expect: z.array(ApiAssertionSchema).optional(),
}).superRefine((step, ctx) => {
  const issue = timeoutMethodIssue(step);
  if (issue) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["timeout"],
      message: issue,
    });
  }
});

export type ApiRequestStep = z.infer<typeof ApiRequestStepSchema>;

export const ApiStepSchema = z.union([ApiRequestStepSchema, ApiWaitStepSchema]);

export type ApiStep = z.infer<typeof ApiStepSchema>;

export function isApiRequestStep(step: ApiStep): step is ApiRequestStep {
  return "request" in step;
}

/**
 * Single source of truth for the web assertion vocabulary — see
 * CLI_ASSERTION_SCHEMAS above for why WEB_ASSERTION_VERBS is derived from
 * this rather than listed separately.
 */
const WEB_ASSERTION_SCHEMAS = {
  url: UrlAssertionSchema,
  visible: VisibleAssertionSchema,
  matches: MatchesAssertionSchema,
  not_visible: NotVisibleAssertionSchema,
} satisfies Record<string, z.ZodTypeAny>;

/** The web-surface assertion verbs — anything else is not a web assertion. */
const WEB_ASSERTION_VERBS = Object.keys(
  WEB_ASSERTION_SCHEMAS,
) as (keyof typeof WEB_ASSERTION_SCHEMAS)[];

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
 * do, for use in a human-facing error message. `run`, `request` and `wait`
 * win when present so a step with an invalid modifier still reports its
 * verb, not "stdin"/"env"/"capture".
 */
function stepVerb(step: unknown): string {
  if (step && typeof step === "object" && !Array.isArray(step)) {
    const record = step as Record<string, unknown>;
    for (const verb of ["run", "request", "wait"]) {
      if (verb in record) {
        return verb;
      }
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

function isApiVerbStep(step: unknown): boolean {
  return (
    !!step &&
    typeof step === "object" &&
    !Array.isArray(step) &&
    ("request" in (step as Record<string, unknown>) ||
      "wait" in (step as Record<string, unknown>))
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
    // The separator between the joined path and the message must be a
    // character that can never appear in either half, or two genuinely
    // different (path, message) pairs could collide into the same key and
    // get wrongly deduped. NUL (\0) is the one character with that
    // guarantee: it can't occur in a Zod issue path segment (a JS property
    // name or array index) or in a Zod-generated message string. Written as
    // the escape `\0` rather than a raw embedded byte — a literal NUL byte
    // in the source file makes `grep`/`ripgrep` classify the whole file as
    // binary, which silently breaks text search over this file.
    const key = `${detail.path.join(".")}\0${detail.message}`;
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
    surface === "cli"
      ? isCliVerbStep(step)
      : surface === "api"
        ? isApiVerbStep(step)
        : isWebVerbStep(step);

  if (!matchesVerbFamily) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `Step verb "${stepVerb(step)}" is not valid for surface "${surface}"`,
    });
    return;
  }

  if (surface === "api") {
    validateApiStep(step as Record<string, unknown>, path, ctx);
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

/**
 * An api step is checked in two parts: its own shape (request, capture,
 * timeout) against the step schema, and each `expect` entry against the api
 * assertion vocabulary at its own path, so a web or CLI assertion inside a
 * step is named the same way a flow-level one is.
 */
function validateApiStep(
  step: Record<string, unknown>,
  path: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  if (!("request" in step)) {
    addSchemaFailureIssues(ApiWaitStepSchema, step, "wait", path, ctx);
    return;
  }

  addSchemaFailureIssues(ApiRequestStepShape, step, "request", path, ctx);

  const timeoutIssue = timeoutMethodIssue(
    step as { request: unknown; timeout?: number },
  );
  if (timeoutIssue) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...path, "timeout"],
      message: timeoutIssue,
    });
  }

  if (Array.isArray(step.expect)) {
    step.expect.forEach((assertion, index) => {
      validateAssertionForSurface(
        assertion,
        "api",
        [...path, "expect", index],
        ctx,
      );
    });
  }
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
const ASSERTION_VOCABULARY = {
  web: { verbs: WEB_ASSERTION_VERBS, schemas: WEB_ASSERTION_SCHEMAS },
  cli: { verbs: CLI_ASSERTION_VERBS, schemas: CLI_ASSERTION_SCHEMAS },
  api: { verbs: API_ASSERTION_VERBS, schemas: API_ASSERTION_SCHEMAS },
} satisfies Record<
  Surface,
  { verbs: readonly string[]; schemas: Record<string, z.ZodTypeAny> }
>;

function validateAssertionForSurface(
  assertion: unknown,
  surface: Surface,
  path: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  const { verbs, schemas } = ASSERTION_VOCABULARY[surface];
  const verb = matchedVerb(assertion, verbs);

  if (!verb) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `Assertion "${assertionVerb(assertion)}" is not valid for surface "${surface}"`,
    });
    return;
  }

  // `schemas` is one of three object-literal maps whose keys are known,
  // narrow string literals (enforced via `satisfies Record<string,
  // z.ZodTypeAny>` at their declarations) — precise enough that
  // Object.keys(...) derives each surface's *_ASSERTION_VERBS without
  // hand-listing them (see those declarations), but too precise for `verb`
  // (a plain string narrowed only at runtime by `matchedVerb`, since
  // `surface` can't correlate which literal-key union it belongs to here).
  // The runtime guarantee that `verb` is actually a key of `schemas` already
  // comes from `matchedVerb` searching exactly this surface's own verb list.
  const schema = (schemas as Record<string, z.ZodTypeAny>)[verb];
  addSchemaFailureIssues(schema, assertion, verb, path, ctx);
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
    validateAssertionForSurface(assertion, surface, ["expect", index], ctx);
  });
}

/**
 * Flow-level rules for `surface: api`:
 * - no `setup` block (the grammar has none; a first request step does the
 *   same job);
 * - a flow-level `expect` is appended to the last step, so that step must be
 *   a request;
 * - at least one assertion somewhere in the flow, the same floor the other
 *   surfaces enforce on their single `expect` list.
 */
function validateApiFlow(
  flow: { setup?: unknown; steps: unknown[]; expect?: unknown[] },
  ctx: z.RefinementCtx,
): void {
  if (flow.setup !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["setup"],
      message:
        'setup is not supported for surface "api"; make the setup request the first step',
    });
  }

  const flowExpect = flow.expect ?? [];
  validateExpectForSurface(flowExpect, "api", ctx);

  const lastStep = flow.steps[flow.steps.length - 1];
  if (flowExpect.length > 0 && !isRecordWith(lastStep, "request")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expect"],
      message:
        "a flow-level expect applies to the last step, which must be a request",
    });
  }

  const stepAssertionCount = flow.steps.reduce<number>((count, step) => {
    const stepExpect = isRecordWith(step, "expect") ? step.expect : undefined;
    return count + (Array.isArray(stepExpect) ? stepExpect.length : 0);
  }, 0);
  if (stepAssertionCount + flowExpect.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expect"],
      message:
        "expect must contain at least one assertion for surface api (on a step or at flow level)",
    });
  }
}

function isRecordWith<K extends string>(
  value: unknown,
  key: K,
): value is Record<K, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, key)
  );
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
    steps: z.array(z.custom<FlowStep | CliStep | ApiStep>()).min(1),
    // Optional at this level only because an api flow may carry all of its
    // assertions on its steps. Web and CLI flows still require it (see the
    // refinement below).
    expect: z
      .array(z.custom<StepAssertion | CliAssertion | ApiAssertion>())
      .optional(),
  })
  .superRefine((flow, ctx) => {
    const { surface } = flow;

    validateStepsForSurface(flow.steps, surface, "steps", ctx);

    if (surface === "api") {
      validateApiFlow(flow, ctx);
      return;
    }

    if (flow.setup) {
      validateStepsForSurface(flow.setup, surface, "setup", ctx);
    }

    if (flow.expect === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expect"],
        message: "Required",
      });
      return;
    }

    // Every surface: a flow whose expect list is empty asserts nothing, and
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
 * A FlowSpec already known to be api-surface: request and wait steps, api
 * assertions, and no setup block.
 */
export type ApiFlowSpec = Omit<
  FlowSpec,
  "surface" | "setup" | "steps" | "expect"
> & {
  surface: "api";
  steps: ApiStep[];
  expect?: ApiAssertion[];
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
 * Confirming re-parse for asApiFlow, on the same terms as CliFlowSpecSchema
 * below: real element schemas, no authoring floor on assertion count.
 */
const ApiFlowSpecSchema = z.object({
  name: z.string(),
  description: z.string(),
  surface: z.literal("api"),
  steps: z.array(ApiStepSchema).min(1),
  expect: z.array(ApiAssertionSchema).optional(),
});

/**
 * Schemas backing asCliFlow/asWebFlow's runtime check (CodeRabbit review,
 * PR #16): CliFlowSpec/WebFlowSpec were hand-written TypeScript narrowings
 * with no schema of their own, so a caller that builds a flow object
 * without going through FlowSpecSchema got no runtime validation at all —
 * exactly what test/cli-runner.test.ts's `cliFlow()` fixture (and its
 * siblings) do, via `as unknown as CliFlowSpec`.
 *
 * These use real `z.array(CliStepSchema)` / `z.array(CliAssertionSchema)`
 * (and the web equivalents) rather than FlowSpecSchema's `z.custom` +
 * superRefine dance. That's deliberately safe here even though a real
 * union at a field like this is what FlowSpecSchema itself avoids (see its
 * doc comment): FlowSpecSchema is the PRIMARY, per-field error-reporting
 * pass — the one a spec author's YAML actually goes through, where superRefine
 * is what turns a union's generic "Invalid input" into a message naming the
 * specific bad verb/key. CliFlowSpecSchema/WebFlowSpecSchema instead run
 * only inside asCliFlow/asWebFlow, on a value that (on every production path)
 * has ALREADY passed FlowSpecSchema's superRefine once — this is a
 * confirming re-parse guarding against a caller that skipped that pass
 * entirely, not the place a human-facing per-field message needs to come
 * from. A coarser "this whole value doesn't match its surface" failure is
 * an acceptable, deliberately-chosen tradeoff for that narrower job.
 *
 * `expect` deliberately has no `.min(1)` here, unlike FlowSpecSchema's own
 * enforced floor of at least one assertion. That floor is an AUTHORING rule
 * ("a published spec must actually assert something"), which is
 * FlowSpecSchema's job at parse time — not a grammar-correctness question,
 * which is this schema's only concern (does `expect` actually hold this
 * surface's assertion vocabulary, whatever its length). Plenty of tests
 * exercise runFlow directly with a hand-built, `expect: []` flow object to
 * test dispatch/execution mechanics unrelated to assertions at all (see
 * test/runner-dispatch.test.ts's own `cliFlow()` fixture) — re-enforcing the
 * authoring floor here would reject exactly that established, legitimate
 * pattern for a reason that has nothing to do with what this schema exists
 * to catch (a wrong-surface verb slipping through an unchecked cast).
 */
const CliFlowSpecSchema = z.object({
  name: z.string(),
  description: z.string(),
  surface: z.literal("cli"),
  setup: z.array(CliStepSchema).optional(),
  steps: z.array(CliStepSchema).min(1),
  expect: z.array(CliAssertionSchema),
});

const WebFlowSpecSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    // Mirrors FlowSpecSchema's own `surface` field exactly (optional,
    // defaulting to "web") rather than a bare `z.literal("web")`: runFlow's
    // dispatch (`flow.surface === "cli"`) treats an absent surface as web, and
    // plenty of callers — runner.test.ts's fixtures among them — build a
    // FlowSpec object directly (never through FlowSpecSchema.parse) with no
    // `surface` key at all. A bare literal would reject exactly the shape
    // production code has always accepted as web.
    // `expect` has no `.min(1)` for the same reason CliFlowSpecSchema's
    // doesn't — see its comment.
    surface: SurfaceSchema.optional().default("web"),
    setup: z.array(FlowStepSchema).optional(),
    steps: z.array(FlowStepSchema).min(1),
    expect: z.array(StepAssertionSchema),
  })
  .refine((value) => value.surface === "web", {
    message: 'surface must be "web" (or absent) for a WebFlowSpec',
    path: ["surface"],
  });

/**
 * Narrow a flow to one surface's vocabulary, at the ONE place the surface is
 * dispatched on (src/runner.ts's runFlow).
 *
 * FlowSpecSchema's superRefine already rejects, at parse time, any flow
 * whose steps/setup/expect don't match its declared surface — so for a
 * flow that actually went through FlowSpecSchema.parse, the re-validation
 * below restates a guarantee already enforced. It exists for the caller
 * that DIDN'T: `flow` is typed as FlowSpec, but nothing prevents a caller
 * from constructing one by hand (test fixtures already do). Parsing against
 * CliFlowSpecSchema/WebFlowSpecSchema here, instead of a bare `as` cast,
 * means such a caller fails loudly at the narrowing point instead of
 * silently handing CliStep/CliAssertion-typed data that was never actually
 * checked to every use site downstream.
 *
 * asCliFlow returns the ORIGINAL `flow`, not CliFlowSpecSchema's parse
 * result — and that's fine, unlike asWebFlow below. CliFlowSpecSchema's
 * `surface` field is a bare `z.literal("cli")`: it has no `.default(...)`,
 * so for `.parse(flow)` to succeed at all, `flow.surface` must ALREADY be
 * the literal `"cli"` on the input. There is no defaulted/derived value the
 * parse produces that the input didn't already have, so returning `flow`
 * unchanged discards nothing.
 */
export function asCliFlow(flow: FlowSpec): CliFlowSpec {
  CliFlowSpecSchema.parse(flow);
  return flow as CliFlowSpec;
}

/**
 * Narrow a flow to the api vocabulary. Like asCliFlow, the surface literal
 * has no default, so the input already carries everything the parse would
 * return and the original object is handed back.
 */
export function asApiFlow(flow: FlowSpec): ApiFlowSpec {
  ApiFlowSpecSchema.parse(flow);
  return flow as ApiFlowSpec;
}

/**
 * asWebFlow, unlike asCliFlow above, must return the PARSED value rather
 * than the original `flow` (CodeRabbit review, this PR). WebFlowSpecSchema's
 * `surface` field is `SurfaceSchema.optional().default("web")` — deliberately
 * not a bare literal, per that schema's own doc comment, because plenty of
 * legitimate callers hand it a flow object with no `surface` key at all. The
 * `.default("web")` only ever takes effect on the value `.parse()` RETURNS;
 * it does nothing to the object passed in. The previous implementation ran
 * `WebFlowSpecSchema.parse(flow)` purely for its throwing side effect and
 * then returned `flow as WebFlowSpec` — so a hand-built flow with no
 * `surface` key parsed successfully (correctly) but came back with
 * `surface === undefined` at runtime, while its WebFlowSpec type claimed the
 * literal `"web"`. That is a real type lie: a caller trusting
 * `webFlow.surface === "web"` could be wrong about a value TypeScript
 * insists is web-surface.
 *
 * The fix returns `WebFlowSpecSchema.parse(flow)` itself, so the defaulted
 * `surface` (and everything else the schema validated) is what callers
 * actually get. This is safe from the "a real z.object() schema silently
 * drops any key it doesn't declare" risk that would otherwise make a
 * re-parse dangerous on a production path: WebFlowSpecSchema declares
 * exactly the five fields FlowSpec itself has (name, description, surface,
 * setup, steps, expect) — there is no sixth FlowSpec field for it to drop.
 * `setup`/`steps`/`expect` re-parse through FlowStepSchema/StepAssertionSchema
 * element-by-element, which reconstructs equivalent objects (same single
 * key, same value) rather than mutating or dropping anything, since those
 * are the same schemas FlowSpecSchema's own superRefine already validated
 * each element against.
 *
 * The one behavior change this causes: the returned object is no longer the
 * same reference as the `flow` argument (a fresh object from `.parse()`).
 * No production call site (src/runner.ts's runFlow) or test in this repo
 * relies on that identity — every consumer reads fields off the result, none
 * compares it by reference to the input — so this is a safe tradeoff for
 * closing a genuine type lie.
 */
export function asWebFlow(flow: FlowSpec): WebFlowSpec {
  return WebFlowSpecSchema.parse(flow) as WebFlowSpec;
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
