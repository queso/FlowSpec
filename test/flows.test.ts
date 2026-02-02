import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import { FlowSpecSchema } from "../src/types";

const VALID_FLOWS_DIR = join(__dirname, "fixtures", "flows", "valid");
const INVALID_FLOWS_DIR = join(__dirname, "fixtures", "flows", "invalid");

describe("YAML Flow Fixtures", () => {
  it("should have all required flow fixture files", () => {
    expect(existsSync(join(VALID_FLOWS_DIR, "login.flow.yaml"))).toBe(true);
    expect(existsSync(join(VALID_FLOWS_DIR, "form-submission.flow.yaml"))).toBe(
      true,
    );
    expect(existsSync(join(VALID_FLOWS_DIR, "navigation.flow.yaml"))).toBe(
      true,
    );
    expect(existsSync(join(INVALID_FLOWS_DIR, "missing-name.flow.yaml"))).toBe(
      true,
    );
    expect(existsSync(join(INVALID_FLOWS_DIR, "invalid-step.flow.yaml"))).toBe(
      true,
    );
    expect(existsSync(join(INVALID_FLOWS_DIR, "empty-steps.flow.yaml"))).toBe(
      true,
    );
  });

  it("valid flows should parse as valid YAML and pass schema", () => {
    const files = [
      "login.flow.yaml",
      "form-submission.flow.yaml",
      "navigation.flow.yaml",
    ];

    for (const file of files) {
      const content = readFileSync(join(VALID_FLOWS_DIR, file), "utf-8");
      const flow = loadYaml(content);
      const result = FlowSpecSchema.safeParse(flow);
      expect(result.success).toBe(true);
    }
  });

  it("invalid flows should fail schema validation", () => {
    const files = [
      "missing-name.flow.yaml",
      "invalid-step.flow.yaml",
      "empty-steps.flow.yaml",
    ];

    for (const file of files) {
      const content = readFileSync(join(INVALID_FLOWS_DIR, file), "utf-8");
      const flow = loadYaml(content);
      const result = FlowSpecSchema.safeParse(flow);
      expect(result.success).toBe(false);
    }
  });
});
