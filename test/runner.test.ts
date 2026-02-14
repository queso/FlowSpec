/**
 * Flow Runner Tests for FlowSpec
 *
 * Integration tests that verify runFlow() executes FlowSpec steps
 * via browser automation and verifies assertions.
 *
 * These tests run against real fixtures served by the test server.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_TIMEOUT,
  POLL_INTERVAL,
  type RunnerOptions,
  runFlow,
} from "../src/runner";
import type { FlowSpec } from "../src/types";
import { hasBrowserBinaries } from "./helpers/has-browser";
import { createTestServer, type TestServer } from "./server";

// Check if Playwright Chromium binaries are installed before running browser tests
const describeIfAgentBrowser = hasBrowserBinaries() ? describe : describe.skip;

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

      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        timeout: 0,
      });

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

      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        timeout: 0,
      });

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

      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        timeout: 0,
      });

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

      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        timeout: 0,
      });

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

      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        timeout: 0,
      });

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

      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        timeout: 0,
      });

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

      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        timeout: 0,
      });

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

  describe("assertion retry/polling", () => {
    it("should accept timeout option in RunnerOptions", async () => {
      const flow: FlowSpec = {
        name: "timeout-option",
        description: "Test timeout option is accepted",
        steps: [{ visit: "/login.html" }],
        expect: [{ visible: "Sign In" }],
      };

      // Should accept timeout: 0 option without error
      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        timeout: 0,
      });

      expect(result.success).toBe(true);
    });

    it("should return immediately on failed assertion when timeout is 0", async () => {
      const flow: FlowSpec = {
        name: "no-retry",
        description: "Test that timeout:0 means no retry",
        steps: [{ visit: "/login.html" }],
        expect: [{ visible: "Nonexistent Text That Will Never Appear" }],
      };

      const startTime = Date.now();
      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        timeout: 0,
      });
      const elapsed = Date.now() - startTime;

      expect(result.success).toBe(false);
      // With timeout:0, should fail immediately without any retry delay
      // Allow some margin for browser operation but should be much less than DEFAULT_TIMEOUT
      expect(elapsed).toBeLessThan(DEFAULT_TIMEOUT);
    });
  });

  describe("wait_for step", () => {
    it("should wait for text that is already visible", async () => {
      const flow: FlowSpec = {
        name: "wait-for-visible",
        description: "Wait for text that exists immediately",
        steps: [{ visit: "/login.html" }, { wait_for: "Sign In" }],
        expect: [{ visible: "Sign In" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(true);
    });

    it("should fail immediately when timeout is 0 and text is not visible", async () => {
      const flow: FlowSpec = {
        name: "wait-for-timeout-zero",
        description: "Fail immediately when text not found with timeout 0",
        steps: [{ visit: "/login.html" }, { wait_for: "Nonexistent Text" }],
        expect: [{ visible: "Sign In" }],
      };

      const startTime = Date.now();
      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        timeout: 0,
      });
      const elapsed = Date.now() - startTime;

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.step).toBe(1);
      expect(result.error?.action).toEqual({ wait_for: "Nonexistent Text" });
      expect(result.error?.message).toContain("Nonexistent Text");
      // Should fail fast with timeout 0
      expect(elapsed).toBeLessThan(DEFAULT_TIMEOUT);
    });

    it("should include timeout in error message when text never appears", async () => {
      const flow: FlowSpec = {
        name: "wait-for-timeout-message",
        description: "Error message should mention timeout",
        steps: [{ visit: "/login.html" }, { wait_for: "Never Appears" }],
        expect: [{ visible: "Sign In" }],
      };

      const customTimeout = 500;
      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        timeout: customTimeout,
      });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain("Timeout");
      expect(result.error?.message).toContain(`${customTimeout}ms`);
    });

    it("should be usable in a flow with multiple steps", async () => {
      const flow: FlowSpec = {
        name: "wait-for-in-flow",
        description: "Use wait_for between other steps",
        steps: [
          { visit: "/dashboard.html" },
          { wait_for: "Welcome back" },
          { click: "Settings" },
        ],
        expect: [{ url: "/settings" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(true);
    });

    it("should capture step index on wait_for failure", async () => {
      const flow: FlowSpec = {
        name: "wait-for-step-index",
        description: "Step index captured on failure",
        steps: [
          { visit: "/login.html" },
          { wait_for: "Sign In" },
          { wait_for: "This Will Not Appear" },
        ],
        expect: [{ visible: "Sign In" }],
      };

      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        timeout: 0,
      });

      expect(result.success).toBe(false);
      expect(result.error?.step).toBe(2);
    });
  });
});

/**
 * Unit tests for assertion retry constants and types
 * These do not require browser automation
 */
describe("Assertion Retry Constants", () => {
  it("should export DEFAULT_TIMEOUT constant with value 5000", () => {
    expect(DEFAULT_TIMEOUT).toBe(5000);
  });

  it("should export POLL_INTERVAL constant with value 250", () => {
    expect(POLL_INTERVAL).toBe(250);
  });

  it("should have DEFAULT_TIMEOUT be a multiple of POLL_INTERVAL", () => {
    // This ensures clean timeout behavior
    expect(DEFAULT_TIMEOUT % POLL_INTERVAL).toBe(0);
  });
});

/**
 * Type-level tests for RunnerOptions interface
 * These verify the TypeScript types are correct at compile time
 */
describe("RunnerOptions type", () => {
  it("should allow timeout as optional number parameter", () => {
    // Type assertions - these will fail to compile if types are wrong
    const optionsWithTimeout: RunnerOptions = { timeout: 1000 };
    const optionsWithZeroTimeout: RunnerOptions = { timeout: 0 };
    const optionsWithoutTimeout: RunnerOptions = {};
    const optionsWithBoth: RunnerOptions = {
      baseUrl: "http://localhost",
      timeout: 500,
    };

    // Runtime verification that the values are correct
    expect(optionsWithTimeout.timeout).toBe(1000);
    expect(optionsWithZeroTimeout.timeout).toBe(0);
    expect(optionsWithoutTimeout.timeout).toBeUndefined();
    expect(optionsWithBoth.timeout).toBe(500);
    expect(optionsWithBoth.baseUrl).toBe("http://localhost");
  });
});
