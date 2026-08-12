import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import { FlowStepSchema } from "./types.js";

/**
 * Schema for FlowSpec project configuration
 */
export const FlowSpecConfigSchema = z.object({
  baseUrl: z.string().url().optional().default("http://localhost:3000"),
  timeout: z.number().positive().optional().default(10000),
  specsDir: z.string().optional().default("specs/"),
  setup: z.array(FlowStepSchema).optional(),
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
  cliOptions: { baseUrl?: string; timeout?: number },
): FlowSpecConfig {
  return {
    baseUrl: cliOptions.baseUrl ?? config.baseUrl,
    timeout: cliOptions.timeout ?? config.timeout,
    specsDir: config.specsDir,
    setup: config.setup,
  };
}
