import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import { addSchemaFailureIssues, FlowStepSchema } from "./types.js";

/**
 * Default process-kill deadline for a CLI run step, in milliseconds.
 *
 * Deliberately far larger than `timeout` (the assertion-retry budget): these
 * are two different clocks that used to share one key. A retry budget of ten
 * seconds is generous; ten seconds as a process deadline kills any real
 * install, build, or network fetch mid-flight and reports it as a timeout.
 */
export const DEFAULT_STEP_TIMEOUT = 60000;

/**
 * The key that names what a raw (not-yet-validated) config-level setup step
 * object is trying to do, for use in a human-facing error message — mirrors
 * the `stepVerb()` helper in src/types.ts.
 */
function configStepVerb(step: unknown): string {
  if (step && typeof step === "object" && !Array.isArray(step)) {
    const [firstKey] = Object.keys(step as Record<string, unknown>);
    return firstKey ?? "unknown";
  }
  return "unknown";
}

/** The web-surface step verbs — mirrors WEB_STEP_VERBS in src/types.ts. */
const WEB_STEP_VERBS = [
  "visit",
  "click",
  "fill",
  "select",
  "wait_for",
] as const;

/** The web verb present on `step`, if any (checked against the known set, not just "the first key"). */
function matchedWebVerb(step: unknown): string | undefined {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    return undefined;
  }
  const record = step as Record<string, unknown>;
  return WEB_STEP_VERBS.find((verb) => verb in record);
}

/**
 * Schema for FlowSpec project configuration
 *
 * `setup`'s field type is deliberately permissive (`z.any()` items) so a
 * non-web step (e.g. a CLI `run` step) parses structurally and the
 * superRefine below can name the offending verb explicitly — binding the
 * field directly to `z.array(FlowStepSchema)` would make Zod's own
 * invalid_union error the one reported, whose top-level message is just
 * "Invalid input" (the useful "Unrecognized key(s): 'run'" detail is buried
 * three levels deep in `unionErrors[].issues[]`, which loadConfigFile's
 * error formatting never reaches). Config-level setup stays web-only by
 * design (see adr/0003 and the PRD) — `FlowStepSchema` is WI-800's WEB step
 * schema, unchanged; this does not accept CLI run steps.
 */
export const FlowSpecConfigSchema = z
  .object({
    baseUrl: z.string().url().optional().default("http://localhost:3000"),
    // Assertion-retry budget ONLY: how long an assertion keeps being
    // re-checked before it is called a failure. Never a process deadline —
    // see stepTimeout below.
    timeout: z.number().positive().optional().default(10000),
    // CLI-surface process-kill deadline: how long a single `run` step may
    // take before its process is killed. A distinct key from `timeout`
    // because the two answer completely different questions, and sharing one
    // value meant the (web-harmless) 10s retry budget silently killed any
    // command that legitimately runs longer.
    stepTimeout: z
      .number()
      .int()
      .positive()
      .optional()
      .default(DEFAULT_STEP_TIMEOUT),
    specsDir: z.string().optional().default("specs/"),
    setup: z.array(z.any()).optional(),
    // Config-level only: HTTP headers applied to the browser session for
    // header-protected deployments (e.g. a Vercel/Netlify bypass token).
    // Deliberately absent from FlowSpecSchema — auth/environment concerns
    // stay in config, out of the committed flow specs (see adr/0003).
    headers: z.record(z.string()).optional(),
    // How far those headers travel. Only meaningful alongside `headers`.
    // Absent means the runner's default, "origin": headers go to baseUrl's
    // origin only, so a bypass token is never handed to a CDN, an analytics
    // pixel, or any other third party the page happens to request. "all" is
    // the explicit opt-out for deployments that need them context-wide.
    headersScope: z.enum(["origin", "all"]).optional(),
    // CLI-surface working-directory override. A relative value resolves
    // against process.cwd() — that resolution, and creating a temp
    // directory when this is absent, is src/workdir.ts's job, not
    // config-loading's.
    //
    // Blank values are rejected rather than accepted: an empty (or
    // whitespace-only) cwd resolves to process.cwd() — the real project
    // directory — so a typo would quietly turn "isolated, disposable temp
    // dir" into "run every step against the working tree, and never clean
    // up". Absent means temp dir; present means a real path.
    cwd: z
      .string()
      .refine((value) => value.trim().length > 0, {
        message:
          "cwd must be a non-empty path (omit the key entirely to use a temporary directory)",
      })
      .optional(),
    // CLI-surface per-stream capture ceiling, in bytes. No schema-level
    // default: this stays undefined when absent, and DEFAULT_CAPTURE_LIMIT
    // (exported by src/exec.ts) is applied downstream by the consumer that
    // actually enforces it, not by config loading.
    captureLimit: z.number().int().positive().optional(),
  })
  .superRefine((config, ctx) => {
    // Two-tier check, mirroring src/types.ts's validateStepForSurface: a
    // verb from outside the web family (e.g. a CLI `run` step) gets the
    // custom "Unsupported step" message naming the offending verb; a step
    // whose verb IS a valid web verb but is otherwise malformed (an extra
    // key, a wrong value type) surfaces that specific problem instead of a
    // misleading "unsupported" wrapper around a verb that actually is
    // supported.
    config.setup?.forEach((step: unknown, index: number) => {
      const verb = matchedWebVerb(step);
      if (verb === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["setup", index],
          message: `Unsupported step "${configStepVerb(step)}" in config-level setup (web steps only)`,
        });
        return;
      }

      // Shared with src/types.ts's flow-level step validation: each
      // specific problem is re-issued at its own field (e.g.
      // "setup.0.visit: Expected string, received number") instead of one
      // generic union message with the field discarded.
      addSchemaFailureIssues(FlowStepSchema, step, verb, ["setup", index], ctx);
    });
  });

export type FlowSpecConfig = z.infer<typeof FlowSpecConfigSchema>;

/**
 * Matches a well-formed ${VAR} reference: an identifier that starts with a
 * letter or underscore, followed by letters, digits, or underscores, closed
 * by a brace. Anything else shaped like "${...}" (unclosed brace, invalid
 * identifier characters, no braces at all) simply never matches and is left
 * untouched by the replace below.
 */
const VAR_REFERENCE_REGEX = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Recursively substitute ${VAR} references in string values with the
 * corresponding process.env value. Object keys are never touched — only
 * string values are walked. Arrays and objects are rebuilt as new
 * references so callers can't alias or mutate a previous load's result.
 *
 * Throws when a referenced variable is absent from process.env (an
 * explicitly empty-string value is a valid, set value and is substituted
 * as "" rather than treated as unset — silently falling back to "" would
 * produce a URL/value that looks correct but is wrong).
 */
function interpolateValue(value: unknown, configPath: string): unknown {
  if (typeof value === "string") {
    return value.replace(VAR_REFERENCE_REGEX, (_match, varName: string) => {
      // An own-property check (not `=== undefined`) is required here:
      // process.env inherits from Object.prototype, so a name like
      // "constructor" or "toString" would otherwise resolve to an inherited
      // function instead of being correctly treated as unset.
      if (!Object.hasOwn(process.env, varName)) {
        throw new Error(
          `Missing environment variable "${varName}" referenced in config file: ${configPath}`,
        );
      }
      return process.env[varName] as string;
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => interpolateValue(item, configPath));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [
        key,
        interpolateValue(val, configPath),
      ]),
    );
  }

  return value;
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: FlowSpecConfig = {
  baseUrl: "http://localhost:3000",
  timeout: 10000,
  stepTimeout: DEFAULT_STEP_TIMEOUT,
  specsDir: "specs/",
};

/**
 * The standard configuration file name
 */
export const CONFIG_FILE_NAME = "flowspec.config.yaml";

/**
 * Find the configuration file by walking up the directory tree
 * @param startDir - Directory to start searching from
 * @returns Path to config file if found, undefined otherwise
 */
export function findConfigFile(
  startDir: string = process.cwd(),
): string | undefined {
  let currentDir = resolve(startDir);
  const root = resolve("/");

  while (currentDir !== root) {
    const configPath = join(currentDir, CONFIG_FILE_NAME);
    if (existsSync(configPath)) {
      return configPath;
    }
    currentDir = resolve(currentDir, "..");
  }

  // Check root as well
  const rootConfig = join(root, CONFIG_FILE_NAME);
  if (existsSync(rootConfig)) {
    return rootConfig;
  }

  return undefined;
}

/**
 * Load and parse a FlowSpec configuration file
 * @param configPath - Path to the config file
 * @returns Parsed configuration
 * @throws Error if file not found or invalid
 */
export function loadConfigFile(configPath: string): FlowSpecConfig {
  if (!existsSync(configPath)) {
    throw new Error(`Configuration file not found: ${configPath}`);
  }

  const content = readFileSync(configPath, "utf-8");

  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch (error) {
    if (error instanceof yaml.YAMLException) {
      throw new Error(
        `Invalid YAML in config file: ${error.reason} at line ${error.mark?.line ?? "unknown"}`,
      );
    }
    throw error;
  }

  // Handle empty file case
  if (parsed === undefined || parsed === null) {
    return DEFAULT_CONFIG;
  }

  // Substitute ${VAR} references before validation, so an unresolved
  // variable is reported as a missing-variable error rather than a schema
  // validation failure (or, worse, silently passing validation).
  parsed = interpolateValue(parsed, configPath);

  const result = FlowSpecConfigSchema.safeParse(parsed);

  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    throw new Error(`Invalid configuration: ${issues.join("; ")}`);
  }

  return result.data;
}

/**
 * Load configuration from the default location or return defaults
 * @param startDir - Directory to start searching from
 * @returns Configuration (from file if found, defaults otherwise)
 */
export function loadConfig(startDir: string = process.cwd()): FlowSpecConfig {
  const configPath = findConfigFile(startDir);

  if (configPath) {
    return loadConfigFile(configPath);
  }

  return DEFAULT_CONFIG;
}

/**
 * Merge CLI options with configuration file values
 * CLI options take precedence over config file values
 */
export function mergeConfig(
  config: FlowSpecConfig,
  cliOptions: {
    baseUrl?: string;
    timeout?: number;
    stepTimeout?: number;
    headers?: Record<string, string>;
  },
): FlowSpecConfig {
  return {
    baseUrl: cliOptions.baseUrl ?? config.baseUrl,
    timeout: cliOptions.timeout ?? config.timeout,
    // The CLI layer validates its own --step-timeout before this point (see
    // src/index.ts): `??` would otherwise let a 0 or negative flag value
    // past the schema's `.positive()` and arm a zero-delay process kill.
    stepTimeout: cliOptions.stepTimeout ?? config.stepTimeout,
    specsDir: config.specsDir,
    setup: config.setup,
    // CLI --header flags REPLACE the config headers block outright — they are
    // not merged key by key. Same replacement-over-merge rule a flow-level
    // setup block follows: a partial override would leave the user guessing
    // which of the two sources supplied any given header.
    headers: cliOptions.headers ?? config.headers,
    headersScope: config.headersScope,
    // Config-only, like setup/headersScope: no CLI-options equivalent for
    // either key in this item's scope.
    cwd: config.cwd,
    captureLimit: config.captureLimit,
  };
}
