/**
 * Assertion Retry Integration Tests for FlowSpec
 *
 * Tests that verify the retry/polling behavior for assertions
 * using the delayed.html fixture page which shows content after 3000ms.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runFlow } from "../src/runner";
import type { FlowSpec } from "../src/types";
import { hasBrowserBinaries } from "./helpers/has-browser";
import { createTestServer, type TestServer } from "./server";

// Check if Playwright Chromium binaries are installed before running browser tests
const describeIfAgentBrowser = hasBrowserBinaries() ? describe : describe.skip;

describeIfAgentBrowser("assertion retry", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = createTestServer();
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it("should retry visible assertion until content appears", async () => {
    // delayed.html shows "Delayed Content Loaded" after 3000ms
    // With 10s timeout, this should pass after retrying
    const flow: FlowSpec = {
      name: "retry-until-visible",
      description: "Test that assertion retries until delayed content appears",
      steps: [{ visit: "/delayed.html" }],
      expect: [{ visible: "Delayed Content Loaded" }],
    };

    const result = await runFlow(flow, {
      baseUrl: server.baseUrl,
      timeout: 10000, // 10 seconds is plenty for 3s delay
    });

    expect(result.success).toBe(true);
    // Duration should be at least 3000ms (time for content to appear)
    expect(result.duration).toBeGreaterThanOrEqual(3000);
  });

  it("should timeout and fail when content never appears", async () => {
    // Use login.html which never has the delayed content text
    const flow: FlowSpec = {
      name: "timeout-never-appears",
      description:
        "Test that assertion fails after timeout when text never appears",
      steps: [{ visit: "/login.html" }],
      expect: [{ visible: "Delayed Content Loaded" }],
    };

    const startTime = Date.now();
    const result = await runFlow(flow, {
      baseUrl: server.baseUrl,
      timeout: 500, // Short timeout
    });
    const elapsed = Date.now() - startTime;

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error?.assertion).toEqual({
      visible: "Delayed Content Loaded",
    });
    // Should have waited approximately the timeout duration before failing
    expect(elapsed).toBeGreaterThanOrEqual(500);
  });

  it("should fail when custom timeout is shorter than content delay", async () => {
    // delayed.html shows content after 3000ms
    // With 500ms timeout, should fail before content appears
    const flow: FlowSpec = {
      name: "custom-timeout-too-short",
      description: "Test that custom timeout is respected",
      steps: [{ visit: "/delayed.html" }],
      expect: [{ visible: "Delayed Content Loaded" }],
    };

    const result = await runFlow(flow, {
      baseUrl: server.baseUrl,
      timeout: 500, // Much shorter than 3000ms page delay
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error?.assertion).toEqual({
      visible: "Delayed Content Loaded",
    });
  });

  it("should fail immediately with timeout: 0 (no retry)", async () => {
    // delayed.html shows content after 3000ms
    // With timeout: 0, should fail on first check without any retry
    const flow: FlowSpec = {
      name: "no-retry-immediate-fail",
      description: "Test that timeout:0 disables retry",
      steps: [{ visit: "/delayed.html" }],
      expect: [{ visible: "Delayed Content Loaded" }],
    };

    const startTime = Date.now();
    const result = await runFlow(flow, {
      baseUrl: server.baseUrl,
      timeout: 0,
    });
    const elapsed = Date.now() - startTime;

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error?.assertion).toEqual({
      visible: "Delayed Content Loaded",
    });
    // Should fail without waiting for the 3000ms content delay
    // Allow margin for browser operations (snapshot takes ~1s)
    expect(elapsed).toBeLessThan(3000);
  });
});
