import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import type { ZodError } from "zod";
import { type FlowSpec, FlowSpecSchema } from "./types.js";

/**
 * Format a Zod validation error into a human-readable message
 */
function formatZodError(error: ZodError): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "root";
    return `${path}: ${issue.message}`;
  });
  return `Schema validation failed: ${issues.join("; ")}`;
}

/**
 * Parse a YAML string into a FlowSpec object
 * @param yamlContent - The YAML string to parse
 * @returns The parsed FlowSpec
 * @throws Error if YAML is invalid or doesn't match FlowSpec schema
 */
export function parseFlowSpec(yamlContent: string): FlowSpec {
  let parsed: unknown;

  try {
    parsed = yaml.load(yamlContent);
  } catch (error) {
    if (error instanceof yaml.YAMLException) {
      throw new Error(
        `Invalid YAML syntax at line ${error.mark?.line ?? "unknown"}, column ${error.mark?.column ?? "unknown"}: ${error.reason}`,
      );
    }
    throw error;
  }

  const result = FlowSpecSchema.safeParse(parsed);

  if (!result.success) {
    throw new Error(formatZodError(result.error));
  }

  return result.data;
}

/**
 * Read and parse a YAML flow file
 * @param filePath - Path to the YAML file
 * @returns The parsed FlowSpec
 * @throws Error if file not found, YAML is invalid, or doesn't match FlowSpec schema
 */
export function parseFlowFile(filePath: string): FlowSpec {
  let content: string;

  try {
    content = readFileSync(filePath, "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`File not found: ${filePath}`);
    }
    throw error;
  }

  return parseFlowSpec(content);
}
