import { describe, expect, it } from "vitest";
import { parseFlowSpec } from "../src/parser";

/**
 * Tests for schema strictness - verifying extra field handling
 */
describe("parseFlowSpec strict mode verification", () => {
  describe("top-level extra fields", () => {
    it("should allow or reject extra top-level fields (documenting current behavior)", () => {
      const yaml = `
name: test-flow
description: Test
extra_unknown_field: should this be allowed?
another_extra: what about this?
steps:
  - visit: /home
expect:
  - visible: Hello
`;
      // Current behavior: extra fields are silently ignored
      // This test documents current behavior
      const result = parseFlowSpec(yaml);
      expect(result.name).toBe("test-flow");
      // Extra fields are NOT in the result (good - Zod strips them by default)
      expect(
        (result as Record<string, unknown>).extra_unknown_field,
      ).toBeUndefined();
    });
  });

  describe("extra fields in steps", () => {
    it("should reject extra fields in visit step due to strict()", () => {
      const yaml = `
name: test
description: Test
steps:
  - visit: /home
    extra: field
expect:
  - visible: Hello
`;
      // Individual action schemas use .strict() so extra fields should fail
      expect(() => parseFlowSpec(yaml)).toThrow();
    });

    it("should reject extra fields in click step due to strict()", () => {
      const yaml = `
name: test
description: Test
steps:
  - click: Submit
    timeout: 5000
expect:
  - visible: Success
`;
      expect(() => parseFlowSpec(yaml)).toThrow();
    });

    it("should reject extra fields in fill step due to strict()", () => {
      const yaml = `
name: test
description: Test
steps:
  - fill:
      username: test
    delay: 100
expect:
  - visible: Welcome
`;
      expect(() => parseFlowSpec(yaml)).toThrow();
    });
  });

  describe("extra fields in assertions", () => {
    it("should reject extra fields in visible assertion due to strict()", () => {
      const yaml = `
name: test
description: Test
steps:
  - visit: /home
expect:
  - visible: Welcome
    timeout: 5000
`;
      expect(() => parseFlowSpec(yaml)).toThrow();
    });

    it("should reject extra fields in url assertion due to strict()", () => {
      const yaml = `
name: test
description: Test
steps:
  - visit: /home
expect:
  - url: /home
    exact: true
`;
      expect(() => parseFlowSpec(yaml)).toThrow();
    });
  });

  describe("combined action keys (should fail)", () => {
    it("should reject step with both visit and click", () => {
      const yaml = `
name: test
description: Test
steps:
  - visit: /home
    click: Submit
expect:
  - visible: Welcome
`;
      // Due to strict(), combining action types should fail
      expect(() => parseFlowSpec(yaml)).toThrow();
    });

    it("should reject assertion with both visible and url", () => {
      const yaml = `
name: test
description: Test
steps:
  - visit: /home
expect:
  - visible: Welcome
    url: /home
`;
      expect(() => parseFlowSpec(yaml)).toThrow();
    });
  });
});
