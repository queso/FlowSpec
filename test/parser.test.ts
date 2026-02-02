import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFlowFile, parseFlowSpec } from "../src/parser";

const VALID_FLOWS_DIR = join(__dirname, "fixtures", "flows", "valid");
const INVALID_FLOWS_DIR = join(__dirname, "fixtures", "flows", "invalid");

describe("parseFlowSpec", () => {
  describe("valid YAML parsing", () => {
    it("should parse valid YAML and return FlowSpec object", () => {
      const yaml = `
name: test-flow
description: A simple test flow
steps:
  - visit: /home
expect:
  - visible: Welcome
`;
      const result = parseFlowSpec(yaml);

      expect(result).toBeDefined();
      expect(result.name).toBe("test-flow");
      expect(result.description).toBe("A simple test flow");
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]).toEqual({ visit: "/home" });
      expect(result.expect).toHaveLength(1);
      expect(result.expect[0]).toEqual({ visible: "Welcome" });
    });

    it("should parse flow with all step types (visit, click, fill, select)", () => {
      const yaml = `
name: full-flow
description: Flow with all action types
steps:
  - visit: /forms
  - fill:
      Email: test@example.com
  - select:
      Country: US
  - click: Submit
expect:
  - visible: Success
`;
      const result = parseFlowSpec(yaml);

      expect(result.steps).toHaveLength(4);
      expect(result.steps[0]).toEqual({ visit: "/forms" });
      expect(result.steps[1]).toEqual({ fill: { Email: "test@example.com" } });
      expect(result.steps[2]).toEqual({ select: { Country: "US" } });
      expect(result.steps[3]).toEqual({ click: "Submit" });
    });

    it("should parse flow with all assertion types (url, visible, matches, not_visible)", () => {
      const yaml = `
name: assertion-flow
description: Flow with all assertion types
steps:
  - visit: /dashboard
expect:
  - url: /dashboard
  - visible: Welcome
  - matches: "Order #\\\\d+"
  - not_visible: Error
`;
      const result = parseFlowSpec(yaml);

      expect(result.expect).toHaveLength(4);
      expect(result.expect[0]).toEqual({ url: "/dashboard" });
      expect(result.expect[1]).toEqual({ visible: "Welcome" });
      expect(result.expect[2]).toEqual({ matches: "Order #\\d+" });
      expect(result.expect[3]).toEqual({ not_visible: "Error" });
    });
  });

  describe("invalid YAML syntax", () => {
    it("should throw on invalid YAML syntax with line info", () => {
      const invalidYaml = `
name: test
description: test
steps:
  - visit: /home
    invalid indentation here
expect:
  - visible: Home
`;
      expect(() => parseFlowSpec(invalidYaml)).toThrow();
      try {
        parseFlowSpec(invalidYaml);
      } catch (error) {
        expect((error as Error).message).toMatch(/line|Line/i);
      }
    });

    it("should throw on malformed YAML with colon issues", () => {
      const invalidYaml = `
name: test: with: colons
description: test
steps:
  - visit: /home
expect:
  - visible: Home
`;
      expect(() => parseFlowSpec(invalidYaml)).toThrow();
    });
  });

  describe("missing required fields", () => {
    it("should throw on missing name field", () => {
      const yaml = `
description: Missing name
steps:
  - visit: /home
expect:
  - visible: Home
`;
      expect(() => parseFlowSpec(yaml)).toThrow();
      try {
        parseFlowSpec(yaml);
      } catch (error) {
        expect((error as Error).message).toMatch(/name/i);
      }
    });

    it("should throw on missing description field", () => {
      const yaml = `
name: test-flow
steps:
  - visit: /home
expect:
  - visible: Home
`;
      expect(() => parseFlowSpec(yaml)).toThrow();
      try {
        parseFlowSpec(yaml);
      } catch (error) {
        expect((error as Error).message).toMatch(/description/i);
      }
    });

    it("should throw on missing steps field", () => {
      const yaml = `
name: test-flow
description: Missing steps
expect:
  - visible: Home
`;
      expect(() => parseFlowSpec(yaml)).toThrow();
      try {
        parseFlowSpec(yaml);
      } catch (error) {
        expect((error as Error).message).toMatch(/steps/i);
      }
    });

    it("should throw on missing expect field", () => {
      const yaml = `
name: test-flow
description: Missing expect
steps:
  - visit: /home
`;
      expect(() => parseFlowSpec(yaml)).toThrow();
      try {
        parseFlowSpec(yaml);
      } catch (error) {
        expect((error as Error).message).toMatch(/expect/i);
      }
    });
  });

  describe("invalid step types", () => {
    it("should throw on unknown step type (hover)", () => {
      const yaml = `
name: invalid-step
description: Contains unknown step type
steps:
  - visit: /home
  - hover: Some Element
expect:
  - visible: Home
`;
      expect(() => parseFlowSpec(yaml)).toThrow();
    });

    it("should throw on unknown step type (drag)", () => {
      const yaml = `
name: invalid-step
description: Contains unknown step type
steps:
  - drag: element
expect:
  - visible: Home
`;
      expect(() => parseFlowSpec(yaml)).toThrow();
    });
  });

  describe("invalid assertion types", () => {
    it("should throw on unknown assertion type", () => {
      const yaml = `
name: invalid-assertion
description: Contains unknown assertion type
steps:
  - visit: /home
expect:
  - contains: text
`;
      expect(() => parseFlowSpec(yaml)).toThrow();
    });

    it("should throw on invalid assertion type (hidden)", () => {
      const yaml = `
name: invalid-assertion
description: Contains unknown assertion type
steps:
  - visit: /home
expect:
  - hidden: element
`;
      expect(() => parseFlowSpec(yaml)).toThrow();
    });
  });

  describe("empty arrays", () => {
    it("should throw on empty steps array", () => {
      const yaml = `
name: empty-steps
description: Has empty steps
steps: []
expect:
  - visible: Home
`;
      expect(() => parseFlowSpec(yaml)).toThrow();
    });

    it("should throw on empty expect array", () => {
      const yaml = `
name: empty-expect
description: Has empty expect
steps:
  - visit: /home
expect: []
`;
      expect(() => parseFlowSpec(yaml)).toThrow();
    });
  });
});

describe("parseFlowFile", () => {
  it("should read file and parse YAML content", () => {
    const filePath = join(VALID_FLOWS_DIR, "login.flow.yaml");
    const result = parseFlowFile(filePath);

    expect(result).toBeDefined();
    expect(result.name).toBe("user-login");
    expect(result.description).toBe("User can log in with valid credentials");
    expect(result.steps).toHaveLength(3);
    expect(result.expect).toHaveLength(2);
  });

  it("should throw descriptive error for non-existent file", () => {
    const nonExistentPath = join(VALID_FLOWS_DIR, "does-not-exist.flow.yaml");
    expect(() => parseFlowFile(nonExistentPath)).toThrow();
    try {
      parseFlowFile(nonExistentPath);
    } catch (error) {
      expect((error as Error).message).toMatch(
        /not found|does not exist|ENOENT/i,
      );
    }
  });

  it("should handle absolute file paths", () => {
    const absolutePath = join(VALID_FLOWS_DIR, "navigation.flow.yaml");
    expect(existsSync(absolutePath)).toBe(true);

    const result = parseFlowFile(absolutePath);
    expect(result.name).toBe("dashboard-navigation");
  });
});

describe("fixture file validation", () => {
  describe("valid fixtures should parse successfully", () => {
    it("should parse login.flow.yaml", () => {
      const filePath = join(VALID_FLOWS_DIR, "login.flow.yaml");
      const result = parseFlowFile(filePath);

      expect(result.name).toBe("user-login");
      expect(result.steps).toContainEqual({ visit: "/login" });
      expect(result.steps).toContainEqual({ click: "Sign In" });
      expect(result.expect).toContainEqual({ url: "/dashboard" });
    });

    it("should parse form-submission.flow.yaml", () => {
      const filePath = join(VALID_FLOWS_DIR, "form-submission.flow.yaml");
      const result = parseFlowFile(filePath);

      expect(result.name).toBe("contact-form-submission");
      expect(result.steps).toContainEqual({ visit: "/forms" });
      expect(result.steps).toContainEqual({
        select: { Category: "Technical Support" },
      });
      expect(result.expect).toContainEqual({ visible: "Thank you" });
      expect(result.expect).toContainEqual({ not_visible: "Error" });
    });

    it("should parse navigation.flow.yaml", () => {
      const filePath = join(VALID_FLOWS_DIR, "navigation.flow.yaml");
      const result = parseFlowFile(filePath);

      expect(result.name).toBe("dashboard-navigation");
      expect(result.steps).toHaveLength(4);
      expect(result.expect).toContainEqual({ url: "/dashboard" });
    });
  });

  describe("invalid fixtures should throw appropriate errors", () => {
    it("should throw on empty-steps.flow.yaml", () => {
      const filePath = join(INVALID_FLOWS_DIR, "empty-steps.flow.yaml");
      expect(() => parseFlowFile(filePath)).toThrow();
    });

    it("should throw on invalid-step.flow.yaml (unknown step type)", () => {
      const filePath = join(INVALID_FLOWS_DIR, "invalid-step.flow.yaml");
      expect(() => parseFlowFile(filePath)).toThrow();
    });

    it("should throw on missing-name.flow.yaml", () => {
      const filePath = join(INVALID_FLOWS_DIR, "missing-name.flow.yaml");
      expect(() => parseFlowFile(filePath)).toThrow();
    });
  });
});
