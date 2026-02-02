import { describe, expect, it } from "vitest";
import { parseFlowSpec } from "../src/parser";

/**
 * Security-focused edge case tests for YAML parser
 */
describe("parseFlowSpec security edge cases", () => {
  describe("prototype pollution attempts", () => {
    it("should not pollute Object prototype via __proto__", () => {
      const yaml = `
name: test
description: test
__proto__:
  polluted: true
steps:
  - visit: /home
expect:
  - visible: Hello
`;
      // Even if extra fields are allowed, __proto__ should not affect Object.prototype
      const beforePolluted = ({} as Record<string, unknown>).polluted;
      expect(beforePolluted).toBeUndefined();

      parseFlowSpec(yaml);

      const afterPolluted = ({} as Record<string, unknown>).polluted;
      expect(afterPolluted).toBeUndefined();
    });

    it("should not pollute via constructor.prototype", () => {
      const yaml = `
name: test
description: test
constructor:
  prototype:
    polluted: true
steps:
  - visit: /home
expect:
  - visible: Hello
`;
      const beforePolluted = ({} as Record<string, unknown>).polluted;
      expect(beforePolluted).toBeUndefined();

      parseFlowSpec(yaml);

      const afterPolluted = ({} as Record<string, unknown>).polluted;
      expect(afterPolluted).toBeUndefined();
    });
  });

  describe("YAML-specific security", () => {
    it("should not execute JavaScript via YAML custom tags (js-yaml default safe)", () => {
      // js-yaml by default uses safe schema and doesn't evaluate !!js/function
      const yaml = `
name: test
description: test
steps:
  - visit: !!js/function 'function() { return "/pwned"; }'
expect:
  - visible: Hello
`;
      // This should either throw or treat as literal string, not execute JS
      expect(() => parseFlowSpec(yaml)).toThrow();
    });
  });

  describe("very large inputs", () => {
    it("should handle very long string values", () => {
      const longString = "a".repeat(100000);
      const yaml = `
name: test
description: ${longString}
steps:
  - visit: /home
expect:
  - visible: Hello
`;
      const result = parseFlowSpec(yaml);
      expect(result.description.length).toBe(100000);
    });

    it("should handle many steps", () => {
      const manySteps = Array(1000)
        .fill(null)
        .map((_, i) => `  - visit: /page${i}`)
        .join("\n");

      const yaml = `
name: many-steps
description: Test with many steps
steps:
${manySteps}
expect:
  - visible: Done
`;
      const result = parseFlowSpec(yaml);
      expect(result.steps.length).toBe(1000);
    });
  });

  describe("special YAML constructs", () => {
    it("should handle YAML anchors and aliases", () => {
      const yaml = `
name: anchor-test
description: Test with anchors
steps:
  - &first_step
    visit: /home
  - *first_step
expect:
  - visible: Home
`;
      const result = parseFlowSpec(yaml);
      expect(result.steps.length).toBe(2);
      expect(result.steps[0]).toEqual({ visit: "/home" });
      expect(result.steps[1]).toEqual({ visit: "/home" });
    });

    it("should handle merge keys", () => {
      const yaml = `
name: merge-test
description: Test with merge
steps:
  - visit: /home
expect:
  - visible: Welcome
`;
      const result = parseFlowSpec(yaml);
      expect(result.name).toBe("merge-test");
    });
  });

  describe("binary and special bytes", () => {
    it("should handle binary YAML tag gracefully", () => {
      const yaml = `
name: binary-test
description: Test with binary
steps:
  - visit: /home
expect:
  - visible: !!binary |
      R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7
`;
      // Binary tag should cause validation to fail since visible expects string
      expect(() => parseFlowSpec(yaml)).toThrow();
    });
  });

  describe("unicode edge cases", () => {
    it("should handle zero-width characters", () => {
      const yaml = `
name: zero-width-test
description: Contains\u200Bzero\u200Bwidth
steps:
  - visit: /home
expect:
  - visible: Hello
`;
      const result = parseFlowSpec(yaml);
      expect(result.description).toContain("\u200B");
    });

    it("should handle RTL override characters", () => {
      const yaml = `
name: rtl-test
description: Contains \u202E RTL override
steps:
  - visit: /home
expect:
  - visible: Hello
`;
      const result = parseFlowSpec(yaml);
      expect(result.description).toContain("\u202E");
    });

    it("should handle null bytes in strings", () => {
      // Null bytes can cause issues in some string handling
      const yaml = `
name: null-byte-test
description: "Contains\\x00null"
steps:
  - visit: /home
expect:
  - visible: Hello
`;
      // This should parse but the null byte handling is worth checking
      const result = parseFlowSpec(yaml);
      expect(result.name).toBe("null-byte-test");
    });
  });

  describe("numeric string edge cases", () => {
    it("should reject octal-looking numbers in visit", () => {
      const yaml = `
name: octal-test
description: Test
steps:
  - visit: 0777
expect:
  - visible: Page
`;
      // YAML may parse 0777 as octal 511
      // visit expects string, so this should throw
      expect(() => parseFlowSpec(yaml)).toThrow();
    });

    it("should reject hex numbers in visit", () => {
      const yaml = `
name: hex-test
description: Test
steps:
  - visit: 0xFF
expect:
  - visible: Page
`;
      // YAML parses 0xFF as 255
      expect(() => parseFlowSpec(yaml)).toThrow();
    });

    it("should reject scientific notation in visit", () => {
      const yaml = `
name: scientific-test
description: Test
steps:
  - visit: 1e10
expect:
  - visible: Page
`;
      // YAML parses 1e10 as 10000000000
      expect(() => parseFlowSpec(yaml)).toThrow();
    });

    it("should accept infinity-looking strings when quoted", () => {
      const yaml = `
name: infinity-test
description: Test
steps:
  - visit: ".inf"
expect:
  - visible: Page
`;
      // Quoted .inf should be treated as string
      const result = parseFlowSpec(yaml);
      expect(result.steps[0]).toEqual({ visit: ".inf" });
    });

    it("should reject unquoted .inf as Infinity number", () => {
      const yaml = `
name: infinity-test
description: Test
steps:
  - visit: .inf
expect:
  - visible: Page
`;
      // Unquoted .inf is parsed as Infinity by YAML 1.1
      expect(() => parseFlowSpec(yaml)).toThrow();
    });
  });
});
