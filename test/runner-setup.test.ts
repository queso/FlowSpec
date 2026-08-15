/**
 * Flow Runner setup-phase tests for FlowSpec (WI-770)
 *
 * Verifies that runFlow() executes setup steps inside the SAME browser
 * session as the flow's own steps, before those steps run, and reports
 * setup failures distinctly from step/assertion failures.
 *
 * The session-continuity test is the anti-fake property this item exists
 * to prove: an implementation that opens a second browser session for
 * setup will make session-check.html render "Not authenticated" and the
 * test will fail. This is deliberately NOT proven via wiring assertions,
 * session names, or mock invocation counts.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runFlow } from "../src/runner";
import type { FlowSpec } from "../src/types";
import { hasBrowserBinaries } from "./helpers/has-browser";
import { createTestServer, type TestServer } from "./server";

const describeIfAgentBrowser = hasBrowserBinaries() ? describe : describe.skip;

describeIfAgentBrowser("Flow Runner setup phase", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = createTestServer();
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  describe("session continuity (anti-fake)", () => {
    it("a flow-level setup step's browser state is observed by the flow's own steps", async () => {
      const flow: FlowSpec = {
        name: "flow-level-setup-continuity",
        description: "Setup plants a cookie; steps observe it",
        setup: [{ visit: "/setup-auth.html" }],
        steps: [{ visit: "/session-check.html" }],
        expect: [{ visible: "Authenticated" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(true);
    });

    it("a config-level setup step's browser state is observed by the flow's own steps", async () => {
      const flow: FlowSpec = {
        name: "config-level-setup-continuity",
        description: "Config-level setup plants a cookie; steps observe it",
        steps: [{ visit: "/session-check.html" }],
        expect: [{ visible: "Authenticated" }],
      };

      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        setup: [{ visit: "/setup-auth.html" }],
      });

      expect(result.success).toBe(true);
    });
  });

  describe("setup precedence", () => {
    it("a flow-level setup block replaces config-level setup entirely instead of merging with it", async () => {
      const flow: FlowSpec = {
        name: "flow-setup-replaces-config-setup",
        description:
          "Flow-level setup never visits setup-auth.html, so config-level setup must not run either",
        setup: [{ visit: "/dashboard.html" }],
        steps: [{ visit: "/session-check.html" }],
        expect: [{ visible: "Not authenticated" }],
      };

      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        // If this config-level setup ran (merged rather than replaced),
        // the cookie would be set and the assertion below would fail.
        setup: [{ visit: "/setup-auth.html" }],
      });

      expect(result.success).toBe(true);
    });

    it("an explicit empty setup list opts out of running config-level setup", async () => {
      const flow: FlowSpec = {
        name: "empty-setup-opts-out",
        description:
          "Flow explicitly wants no setup, even though config has one",
        setup: [],
        steps: [{ visit: "/session-check.html" }],
        expect: [{ visible: "Not authenticated" }],
      };

      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        setup: [{ visit: "/setup-auth.html" }],
      });

      expect(result.success).toBe(true);
    });
  });

  describe("setup failure reporting", () => {
    it("reports a failing setup step with phase 'setup', its 0-indexed position in the setup array, and the failing step as the action", async () => {
      const failingSetupStep = { click: "Nonexistent Element ZZZ" };
      const flow: FlowSpec = {
        name: "setup-step-fails",
        description: "Second setup step fails after the first succeeds",
        // The first step succeeding before the second fails is itself
        // evidence that setup steps run in order, not just the last one.
        setup: [{ visit: "/setup-auth.html" }, failingSetupStep],
        steps: [{ visit: "/dashboard.html" }],
        expect: [{ visible: "Dashboard" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(false);
      expect(result.error?.phase).toBe("setup");
      expect(result.error?.step).toBe(1);
      expect(result.error?.action).toEqual(failingSetupStep);
    });

    it("reports a failing flow step (setup already succeeded) with no phase set, indexing into flow.steps as before", async () => {
      const failingFlowStep = { click: "Nonexistent Element ZZZ" };
      const flow: FlowSpec = {
        name: "flow-step-fails-after-setup-succeeds",
        description: "Setup succeeds; the flow's own second step fails",
        setup: [{ visit: "/setup-auth.html" }],
        steps: [{ visit: "/dashboard.html" }, failingFlowStep],
        expect: [{ visible: "Dashboard" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(false);
      expect(result.error?.phase).toBeUndefined();
      expect(result.error?.step).toBe(1);
      expect(result.error?.action).toEqual(failingFlowStep);
    });
  });

  describe("no-setup regression (byte-identical to pre-setup behavior)", () => {
    it("a successful flow with no setup at either level returns only success/flowName/duration", async () => {
      const flow: FlowSpec = {
        name: "no-setup-success",
        description: "No setup field on the flow, no setup option supplied",
        steps: [{ visit: "/login.html" }],
        expect: [{ visible: "Sign In" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(true);
      expect(Object.keys(result).sort()).toEqual(
        ["duration", "flowName", "success"].sort(),
      );
    });

    it("a failing flow with no setup at either level has no phase and no skipped field on the result", async () => {
      const failingStep = { click: "Nonexistent Element ZZZ" };
      const flow: FlowSpec = {
        name: "no-setup-failure",
        description: "No setup field on the flow, no setup option supplied",
        steps: [{ visit: "/dashboard.html" }, failingStep],
        expect: [{ visible: "Dashboard" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(false);
      expect(result.error?.phase).toBeUndefined();
      expect(result.error?.step).toBe(1);
      expect(result.skipped).toBeUndefined();
    });
  });
});
