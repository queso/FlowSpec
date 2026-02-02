/**
 * Flow Runner Tests for FlowSpec
 *
 * Integration tests that verify runFlow() executes FlowSpec steps
 * via browser automation and verifies assertions.
 *
 * These tests run against real fixtures served by the test server.
 */

import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runFlow } from "../src/runner";
import type { FlowSpec } from "../src/types";
import { createTestServer, type TestServer } from "./server";

// Check if agent-browser CLI is available before running tests
const agentBrowserCheck = spawnSync("agent-browser", ["--version"], {
  stdio: "ignore",
});
const hasAgentBrowser = agentBrowserCheck.status === 0;
const describeIfAgentBrowser = hasAgentBrowser ? describe : describe.skip;

describeIfAgentBrowser("Flow Runner", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = createTestServer();
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  describe("runFlow options", () => {
    it("should accept optional RunnerOptions with baseUrl parameter", async () => {
      const flow: FlowSpec = {
        name: "simple-visit",
        description: "Visit a page",
        steps: [{ visit: "/login.html" }],
        expect: [{ visible: "Sign In" }],
      };

      // Should accept options with baseUrl
      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result).toBeDefined();
      expect(result.flowName).toBe("simple-visit");
    });

    it("should use default baseUrl of http://localhost:3456 when no options provided", async () => {
      const flow: FlowSpec = {
        name: "default-base",
        description: "Uses default baseUrl",
        steps: [{ visit: "/login.html" }],
        expect: [{ visible: "Sign In" }],
      };

      // Should work without options (uses default port 3456)
      const result = await runFlow(flow);

      expect(result.success).toBe(true);
    });
  });

  describe("visit step", () => {
    it("should navigate to URL with visit step", async () => {
      const flow: FlowSpec = {
        name: "visit-login",
        description: "Navigate to login page",
        steps: [{ visit: "/login.html" }],
        expect: [{ visible: "Sign In" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(true);
      expect(result.flowName).toBe("visit-login");
      expect(result.duration).toBeGreaterThan(0);
    });

    it("should prepend baseUrl to relative URLs", async () => {
      const flow: FlowSpec = {
        name: "relative-url",
        description: "Test relative URL handling",
        steps: [{ visit: "/dashboard.html" }],
        expect: [{ visible: "Dashboard" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(true);
    });
  });

  describe("click step", () => {
    it("should find and click element by visible text", async () => {
      const flow: FlowSpec = {
        name: "click-button",
        description: "Click a button by its text",
        steps: [{ visit: "/forms.html" }, { click: "Cancel" }],
        expect: [{ visible: "Contact Form" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(true);
    });

    it("should click navigation links by text", async () => {
      const flow: FlowSpec = {
        name: "click-link",
        description: "Click a navigation link",
        steps: [{ visit: "/dashboard.html" }, { click: "Settings" }],
        expect: [{ url: "/settings" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(true);
    });
  });

  describe("fill step", () => {
    it("should fill form fields by label", async () => {
      const flow: FlowSpec = {
        name: "fill-form",
        description: "Fill form fields",
        steps: [
          { visit: "/login.html" },
          { fill: { Email: "user@example.com", Password: "secret123" } },
        ],
        expect: [{ visible: "Sign In" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(true);
    });

    it("should fill multiple fields in a single fill step", async () => {
      const flow: FlowSpec = {
        name: "fill-multiple",
        description: "Fill multiple fields at once",
        steps: [
          { visit: "/forms.html" },
          { fill: { Name: "John Doe", Message: "Hello world" } },
        ],
        expect: [{ visible: "Contact Form" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(true);
    });
  });

  describe("select step", () => {
    it("should select dropdown option by text", async () => {
      const flow: FlowSpec = {
        name: "select-option",
        description: "Select a dropdown option",
        steps: [
          { visit: "/forms.html" },
          { select: { Category: "Technical Support" } },
        ],
        expect: [{ visible: "Contact Form" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(true);
    });
  });

  describe("url assertion", () => {
    it("should verify current URL ends with expected path", async () => {
      const flow: FlowSpec = {
        name: "url-check",
        description: "Check URL after navigation",
        steps: [{ visit: "/dashboard.html" }],
        expect: [{ url: "/dashboard.html" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(true);
    });

    it("should fail when URL does not match expected path", async () => {
      const flow: FlowSpec = {
        name: "url-mismatch",
        description: "URL should not match",
        steps: [{ visit: "/login.html" }],
        expect: [{ url: "/dashboard.html" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.assertion).toEqual({ url: "/dashboard.html" });
    });
  });

  describe("visible assertion", () => {
    it("should verify text is visible on page", async () => {
      const flow: FlowSpec = {
        name: "visible-check",
        description: "Check text is visible",
        steps: [{ visit: "/dashboard.html" }],
        expect: [{ visible: "Welcome back, User!" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(true);
    });

    it("should fail when expected text is not visible", async () => {
      const flow: FlowSpec = {
        name: "not-visible",
        description: "Text should not be found",
        steps: [{ visit: "/login.html" }],
        expect: [{ visible: "Dashboard" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.assertion).toEqual({ visible: "Dashboard" });
    });
  });

  describe("matches assertion", () => {
    it("should verify content matches regex pattern", async () => {
      const flow: FlowSpec = {
        name: "regex-match",
        description: "Check content matches pattern",
        steps: [{ visit: "/dashboard.html" }],
        expect: [{ matches: "Projects: \\d+" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(true);
    });

    it("should fail when content does not match regex", async () => {
      const flow: FlowSpec = {
        name: "regex-no-match",
        description: "Pattern should not match",
        steps: [{ visit: "/login.html" }],
        expect: [{ matches: "Order #\\d{5}" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.assertion).toEqual({ matches: "Order #\\d{5}" });
    });
  });

  describe("not_visible assertion", () => {
    it("should verify text is NOT visible on page", async () => {
      const flow: FlowSpec = {
        name: "not-visible-check",
        description: "Check text is absent",
        steps: [{ visit: "/login.html" }],
        expect: [{ not_visible: "Dashboard" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(true);
    });

    it("should fail when text that should be absent is visible", async () => {
      const flow: FlowSpec = {
        name: "unexpectedly-visible",
        description: "Text should be absent but is present",
        steps: [{ visit: "/dashboard.html" }],
        expect: [{ not_visible: "Welcome back" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.assertion).toEqual({ not_visible: "Welcome back" });
    });
  });

  describe("step failure handling", () => {
    it("should capture step index on failure", async () => {
      const flow: FlowSpec = {
        name: "step-failure",
        description: "Fail on a specific step",
        steps: [
          { visit: "/login.html" },
          { click: "Nonexistent Button" }, // This should fail
        ],
        expect: [{ visible: "Success" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.step).toBe(1); // 0-indexed, second step
    });

    it("should capture action that caused failure", async () => {
      const flow: FlowSpec = {
        name: "action-capture",
        description: "Capture the failing action",
        steps: [
          { visit: "/login.html" },
          { fill: { "Missing Field": "value" } },
        ],
        expect: [{ visible: "Success" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(false);
      expect(result.error?.action).toEqual({
        fill: { "Missing Field": "value" },
      });
    });

    it("should capture current URL on failure", async () => {
      const flow: FlowSpec = {
        name: "url-on-failure",
        description: "URL captured when step fails",
        steps: [{ visit: "/forms.html" }, { click: "Nonexistent" }],
        expect: [{ visible: "Success" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain("forms.html");
    });
  });

  describe("assertion failure handling", () => {
    it("should capture which assertion failed", async () => {
      const flow: FlowSpec = {
        name: "assertion-detail",
        description: "Capture assertion details",
        steps: [{ visit: "/login.html" }],
        expect: [{ visible: "Sign In" }, { visible: "Not Here" }], // Second should fail
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(false);
      expect(result.error?.assertion).toEqual({ visible: "Not Here" });
    });

    it("should include expected value in error", async () => {
      const flow: FlowSpec = {
        name: "expected-value",
        description: "Error includes expected value",
        steps: [{ visit: "/login.html" }],
        expect: [{ url: "/expected-path" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain("/expected-path");
    });

    it("should include actual value in error message", async () => {
      const flow: FlowSpec = {
        name: "actual-value",
        description: "Error includes actual value",
        steps: [{ visit: "/login.html" }],
        expect: [{ url: "/wrong-page" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(false);
      // Error message should mention the actual URL
      expect(result.error?.message).toContain("login.html");
    });
  });

  describe("complete flow execution", () => {
    it("should execute multiple steps and assertions successfully", async () => {
      const flow: FlowSpec = {
        name: "complete-flow",
        description: "Full login flow test",
        steps: [
          { visit: "/login.html" },
          { fill: { Email: "test@example.com", Password: "password123" } },
        ],
        expect: [
          { url: "/login.html" },
          { visible: "Sign In" },
          { not_visible: "Dashboard" },
        ],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(true);
      expect(result.duration).toBeGreaterThan(0);
    });

    it("should track timing for performance reporting", async () => {
      const flow: FlowSpec = {
        name: "timing-test",
        description: "Verify timing is tracked",
        steps: [{ visit: "/dashboard.html" }],
        expect: [{ visible: "Dashboard" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.duration).toBeDefined();
      expect(typeof result.duration).toBe("number");
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });
});
