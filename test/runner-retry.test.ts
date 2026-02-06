/**
 * Assertion Retry Integration Tests for FlowSpec
 *
 * Tests that verify the retry/polling behavior for assertions
 * using the delayed.html fixture page which shows content after 500ms.
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

describeIfAgentBrowser("assertion retry", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = createTestServer();
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it(
    "should retry visible assertion until content appears",
    { timeout: 30000 },
    async () => {
      // delayed.html shows "Delayed Content Loaded" after 500ms
      // With default timeout (5000ms), this should pass
      const flow: FlowSpec = {
        name: "retry-until-visible",
        description:
          "Test that assertion retries until delayed content appears",
        steps: [{ visit: "/delayed.html" }],
        expect: [{ visible: "Delayed Content Loaded" }],
      };

      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        timeout: 2000, // 2 seconds is plenty for 500ms delay
      });

      expect(result.success).toBe(true);
      // Duration should be at least 500ms (time for content to appear)
      expect(result.duration).toBeGreaterThanOrEqual(500);
    },
  );

  it(
    "should timeout and fail when content never appears",
    { timeout: 30000 },
    async () => {
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
    },
  );

  it(
    "should fail when custom timeout is shorter than content delay",
    { timeout: 30000 },
    async () => {
      // delayed.html shows content after 500ms
      // With 100ms timeout, should fail before content appears
      const flow: FlowSpec = {
        name: "custom-timeout-too-short",
        description: "Test that custom timeout is respected",
        steps: [{ visit: "/delayed.html" }],
        expect: [{ visible: "Delayed Content Loaded" }],
      };

      const startTime = Date.now();
      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        timeout: 100, // Shorter than 500ms page delay
      });
      const elapsed = Date.now() - startTime;

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.assertion).toEqual({
        visible: "Delayed Content Loaded",
      });
      // Should have failed within the timeout window, not waiting full 500ms
      expect(elapsed).toBeLessThan(500);
    },
  );

  it(
    "should fail immediately with timeout: 0 (no retry)",
    { timeout: 30000 },
    async () => {
      // delayed.html shows content after 500ms
      // With timeout: 0, should fail immediately without any retry
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
      // Should fail immediately without waiting for the 500ms content delay
      // Allow some margin for browser operation but should be much faster than content delay
      expect(elapsed).toBeLessThan(500);
    },
  );
});
