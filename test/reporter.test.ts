import { describe, expect, it } from "vitest";
import { formatResult, formatSummary } from "../src/reporter";
import type { FlowResult } from "../src/types";

// ANSI color codes for verification
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

describe("Reporter", () => {
  describe("formatResult", () => {
    describe("success cases", () => {
      it("should show checkmark and duration for successful flow", () => {
        const result: FlowResult = {
          success: true,
          flowName: "user-login",
          duration: 123,
        };

        const output = formatResult(result);

        expect(output).toContain("user-login");
        expect(output).toContain("123ms");
      });

      it("should use green color for successful flow", () => {
        const result: FlowResult = {
          success: true,
          flowName: "checkout",
          duration: 500,
        };

        const output = formatResult(result);

        expect(output).toContain(GREEN);
        expect(output).toContain(RESET);
      });

      it("should format duration in seconds when >= 1000ms", () => {
        const result: FlowResult = {
          success: true,
          flowName: "long-flow",
          duration: 2500,
        };

        const output = formatResult(result);

        expect(output).toContain("2.5s");
      });

      it("should format duration in ms when < 1000ms", () => {
        const result: FlowResult = {
          success: true,
          flowName: "quick-flow",
          duration: 42,
        };

        const output = formatResult(result);

        expect(output).toContain("42ms");
      });
    });

    describe("failure cases", () => {
      it("should show X mark and error details for failed flow", () => {
        const result: FlowResult = {
          success: false,
          flowName: "broken-flow",
          duration: 456,
          error: {
            message: "Element not found",
            step: 2,
            action: { click: "Submit" },
          },
        };

        const output = formatResult(result);

        expect(output).toContain("broken-flow");
        expect(output).toContain("456ms");
        expect(output).toContain("Step 2");
        expect(output).toContain("click");
        expect(output).toContain("Submit");
        expect(output).toContain("Element not found");
      });

      it("should use red color for failed flow", () => {
        const result: FlowResult = {
          success: false,
          flowName: "error-flow",
          duration: 100,
          error: {
            message: "Timeout",
          },
        };

        const output = formatResult(result);

        expect(output).toContain(RED);
        expect(output).toContain(RESET);
      });

      it("should handle failure without step number", () => {
        const result: FlowResult = {
          success: false,
          flowName: "setup-fail",
          duration: 50,
          error: {
            message: "Connection refused",
          },
        };

        const output = formatResult(result);

        expect(output).toContain("setup-fail");
        expect(output).toContain("Connection refused");
      });

      it("should format visit action in error output", () => {
        const result: FlowResult = {
          success: false,
          flowName: "nav-fail",
          duration: 200,
          error: {
            message: "Page not found",
            step: 1,
            action: { visit: "/nonexistent" },
          },
        };

        const output = formatResult(result);

        expect(output).toContain("Step 1");
        expect(output).toContain("visit");
        expect(output).toContain("/nonexistent");
      });

      it("should format fill action in error output", () => {
        const result: FlowResult = {
          success: false,
          flowName: "form-fail",
          duration: 300,
          error: {
            message: "Field not found",
            step: 3,
            action: { fill: { Email: "test@example.com" } },
          },
        };

        const output = formatResult(result);

        expect(output).toContain("Step 3");
        expect(output).toContain("fill");
      });
    });
  });

  describe("formatSummary", () => {
    it("should show total, passed, and failed counts", () => {
      const results: FlowResult[] = [
        { success: true, flowName: "flow-1", duration: 100 },
        { success: true, flowName: "flow-2", duration: 200 },
        {
          success: false,
          flowName: "flow-3",
          duration: 150,
          error: { message: "Failed" },
        },
      ];

      const output = formatSummary(results);

      expect(output).toContain("3 flows");
      expect(output).toContain("2 passed");
      expect(output).toContain("1 failed");
    });

    it("should handle all passing flows", () => {
      const results: FlowResult[] = [
        { success: true, flowName: "flow-1", duration: 100 },
        { success: true, flowName: "flow-2", duration: 200 },
      ];

      const output = formatSummary(results);

      expect(output).toContain("2 flows");
      expect(output).toContain("2 passed");
      expect(output).toContain("0 failed");
    });

    it("should handle all failing flows", () => {
      const results: FlowResult[] = [
        {
          success: false,
          flowName: "flow-1",
          duration: 100,
          error: { message: "Error 1" },
        },
        {
          success: false,
          flowName: "flow-2",
          duration: 200,
          error: { message: "Error 2" },
        },
      ];

      const output = formatSummary(results);

      expect(output).toContain("2 flows");
      expect(output).toContain("0 passed");
      expect(output).toContain("2 failed");
    });

    it("should handle empty results array", () => {
      const results: FlowResult[] = [];

      const output = formatSummary(results);

      expect(output).toContain("0 flows");
    });

    it("should handle single flow", () => {
      const results: FlowResult[] = [
        { success: true, flowName: "solo-flow", duration: 50 },
      ];

      const output = formatSummary(results);

      expect(output).toContain("1 flow");
      expect(output).toContain("1 passed");
      expect(output).toContain("0 failed");
    });
  });
});
