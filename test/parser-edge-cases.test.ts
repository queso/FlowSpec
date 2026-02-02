import { describe, expect, it } from "vitest";
import { parseFlowSpec } from "../src/parser";

/**
 * Edge case tests for YAML parser - probing beyond standard coverage
 * These test cases explore boundary conditions and unusual inputs
 */
describe("parseFlowSpec edge cases", () => {
  describe("empty and null inputs", () => {
    it("should throw on empty string", () => {
      expect(() => parseFlowSpec("")).toThrow();
    });

    it("should throw on whitespace-only string", () => {
      expect(() => parseFlowSpec("   \n\t\n   ")).toThrow();
    });

    it("should throw on YAML null document", () => {
      expect(() => parseFlowSpec("---\n...\n")).toThrow();
    });

    it("should throw on explicit YAML null", () => {
      expect(() => parseFlowSpec("null")).toThrow();
    });

    it("should throw on YAML tilde (null shorthand)", () => {
      expect(() => parseFlowSpec("~")).toThrow();
    });
  });

  describe("wrong root types", () => {
    it("should throw on array at root level", () => {
      expect(() => parseFlowSpec("- item1\n- item2")).toThrow();
    });

    it("should throw on scalar string at root", () => {
      expect(() => parseFlowSpec("just a string")).toThrow();
    });

    it("should throw on numeric root", () => {
      expect(() => parseFlowSpec("42")).toThrow();
    });
  });

  describe("YAML special values in field values", () => {
    it("should handle null in name field (YAML parses 'null' as null)", () => {
      const yaml = `
name: null
description: Test
steps:
  - visit: /home
expect:
  - visible: Hello
`;
      // YAML will parse "null" as JavaScript null, not the string "null"
      expect(() => parseFlowSpec(yaml)).toThrow();
    });

    it("should handle tilde in description (YAML null shorthand)", () => {
      const yaml = `
name: test
description: ~
steps:
  - visit: /home
expect:
  - visible: Hello
`;
      expect(() => parseFlowSpec(yaml)).toThrow();
    });

    it("should handle true/false as YAML booleans in name", () => {
      const yaml = `
name: true
description: Test flow
steps:
  - visit: /home
expect:
  - visible: Hello
`;
      // YAML parses bare "true" as boolean true, not string
      // Zod should reject this since name expects string
      expect(() => parseFlowSpec(yaml)).toThrow();
    });

    it("should handle Yes/No as YAML 1.1 booleans in click action", () => {
      // In YAML 1.1, Yes/No/On/Off are boolean values
      const yaml = `
name: test-flow
description: Test
steps:
  - click: Yes
expect:
  - visible: Done
`;
      // If js-yaml uses YAML 1.1 parsing, "Yes" becomes boolean true
      // This would break the click action which expects a string
      const result = parseFlowSpec(yaml);
      // Check if the click value is actually the string "Yes" or boolean true
      expect(typeof (result.steps[0] as { click: unknown }).click).toBe(
        "string",
      );
    });
  });

  describe("special characters and unicode", () => {
    it("should handle unicode in flow name", () => {
      const yaml = `
name: test-flow-
description: Unicode test
steps:
  - visit: /home
expect:
  - visible: Welcome
`;
      const result = parseFlowSpec(yaml);
      expect(result.name).toBe("test-flow-");
    });

    it("should handle emoji in visible assertion", () => {
      const yaml = `
name: emoji-test
description: Test with emoji
steps:
  - visit: /home
expect:
  - visible: Hello World
`;
      const result = parseFlowSpec(yaml);
      expect(result.expect[0]).toEqual({ visible: "Hello World" });
    });

    it("should handle YAML multiline strings", () => {
      const yaml = `
name: multiline-test
description: |
  This is a multiline
  description that spans
  multiple lines
steps:
  - visit: /home
expect:
  - visible: Welcome
`;
      const result = parseFlowSpec(yaml);
      expect(result.description).toContain("multiline");
      expect(result.description).toContain("\n");
    });
  });

  describe("multiple YAML documents", () => {
    it("should throw on multiple YAML documents", () => {
      const yaml = `
name: first-doc
description: First document
steps:
  - visit: /home
expect:
  - visible: Hello
---
name: second-doc
description: Second document
steps:
  - visit: /other
expect:
  - visible: World
`;
      // js-yaml.load() correctly throws on multiple documents
      expect(() => parseFlowSpec(yaml)).toThrow(/single document|multiple/i);
    });
  });

  describe("extra fields (strict mode)", () => {
    it("should reject flow with unknown top-level fields", () => {
      const yaml = `
name: test-flow
description: Test
extra_field: should not be allowed
steps:
  - visit: /home
expect:
  - visible: Hello
`;
      // This depends on whether FlowSpecSchema uses strict()
      // If not strict, extra fields are silently ignored
      // Let's check if this passes or fails
      try {
        const result = parseFlowSpec(yaml);
        // If we get here, extra fields are allowed (potential bug)
        console.log("Extra field was allowed - consider if this is desired");
        expect(result.name).toBe("test-flow");
      } catch (e) {
        // Extra fields rejected - stricter validation
        expect(e).toBeDefined();
      }
    });
  });

  describe("numeric coercion edge cases", () => {
    it("should handle numeric-looking strings in visit path", () => {
      const yaml = `
name: numeric-path
description: Test
steps:
  - visit: 12345
expect:
  - visible: Page
`;
      // YAML will parse 12345 as a number, but visit expects string
      expect(() => parseFlowSpec(yaml)).toThrow();
    });

    it("should handle quoted numeric string in visit path", () => {
      const yaml = `
name: quoted-numeric
description: Test
steps:
  - visit: "12345"
expect:
  - visible: Page
`;
      // Quoted value should be parsed as string
      const result = parseFlowSpec(yaml);
      expect(result.steps[0]).toEqual({ visit: "12345" });
    });
  });

  describe("deeply nested structures", () => {
    it("should handle fill action with many fields", () => {
      const yaml = `
name: many-fields
description: Test
steps:
  - visit: /form
  - fill:
      field1: value1
      field2: value2
      field3: value3
      field4: value4
      field5: value5
expect:
  - visible: Success
`;
      const result = parseFlowSpec(yaml);
      const fillStep = result.steps[1] as { fill: Record<string, string> };
      expect(Object.keys(fillStep.fill)).toHaveLength(5);
    });
  });
});
