/**
 * Flow Runner header-application tests for FlowSpec
 *
 * Verifies that runFlow() applies `options.headers` to the browser session
 * before anything else runs (setup steps included), and reports a failure to
 * apply them distinctly from step/assertion failures.
 *
 * The anti-fake property: the fixture server's /echo-header route renders the
 * value of the `x-flowspec-test` REQUEST header. Client-side JS cannot read
 * request headers, and the route is dynamic server-side, so the only way the
 * page can say "Header: granted" is if the header genuinely rode along with
 * the browser's request. This is deliberately NOT proven via mocks, spies, or
 * command-invocation counts.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runFlow } from "../src/runner";
import type { FlowSpec } from "../src/types";
import { hasBrowserBinaries } from "./helpers/has-browser";
import { createTestServer, type TestServer } from "./server";

const describeIfAgentBrowser = hasBrowserBinaries() ? describe : describe.skip;

describeIfAgentBrowser("Flow Runner header application", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = createTestServer();
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  describe("headers reach the server (anti-fake)", () => {
    it("sends configured headers with the browser's own page requests", async () => {
      const flow: FlowSpec = {
        name: "headers-are-sent",
        description: "The server echoes back the header it received",
        steps: [{ visit: "/echo-header" }],
        expect: [{ visible: "Header: granted" }],
      };

      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        headers: { "x-flowspec-test": "granted" },
      });

      expect(result.success).toBe(true);
    });

    it("does not send the header when no headers are configured (negative control)", async () => {
      const flow: FlowSpec = {
        name: "no-headers-negative-control",
        description: "Without headers the server reports nothing received",
        steps: [{ visit: "/echo-header" }],
        expect: [{ visible: "No header received" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(true);
    });

    it("fails an assertion that expects the header when no headers are configured (negative control, other direction)", async () => {
      const flow: FlowSpec = {
        name: "no-headers-cannot-fake-success",
        description:
          "The echoed-header assertion must be unsatisfiable without headers",
        steps: [{ visit: "/echo-header" }],
        expect: [{ visible: "Header: granted" }],
      };

      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        timeout: 0,
      });

      expect(result.success).toBe(false);
      expect(result.error?.assertion).toEqual({ visible: "Header: granted" });
    });

    it("does not mutate the caller's headers object", async () => {
      const headers = { "x-flowspec-test": "granted" };
      const flow: FlowSpec = {
        name: "headers-not-mutated",
        description: "The caller's headers object is read, never written",
        steps: [{ visit: "/echo-header" }],
        expect: [{ visible: "Header: granted" }],
      };

      await runFlow(flow, { baseUrl: server.baseUrl, headers });

      expect(headers).toEqual({ "x-flowspec-test": "granted" });
    });
  });

  describe("ordering: headers are applied before setup", () => {
    it("a setup step's page request already carries the configured headers", async () => {
      const flow: FlowSpec = {
        name: "headers-precede-setup",
        description:
          "Setup navigates to /echo-header; the flow's own step never navigates, " +
          "so the echoed value can only come from the setup-time request",
        setup: [{ visit: "/echo-header" }],
        steps: [{ wait_for: "Header: granted" }],
        expect: [{ visible: "Header: granted" }],
      };

      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        headers: { "x-flowspec-test": "granted" },
        timeout: 1000,
      });

      expect(result.success).toBe(true);
    });

    it("that same setup-time page shows nothing received when headers are absent (negative control)", async () => {
      const flow: FlowSpec = {
        name: "setup-without-headers",
        description: "Same shape, no headers configured",
        setup: [{ visit: "/echo-header" }],
        steps: [{ wait_for: "No header received" }],
        expect: [{ visible: "No header received" }],
      };

      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        timeout: 1000,
      });

      expect(result.success).toBe(true);
    });
  });

  describe("failure reporting", () => {
    it("reports a header-application failure with phase 'headers' and no step/action", async () => {
      const flow: FlowSpec = {
        name: "headers-fail-to-apply",
        description: "An invalid header name is rejected by the browser",
        steps: [{ visit: "/echo-header" }],
        expect: [{ visible: "No header received" }],
      };

      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        // A header name containing a space is not a valid HTTP field name;
        // the browser rejects it when the headers are applied.
        headers: { "bad header": "x" },
      });

      expect(result.success).toBe(false);
      expect(result.error?.phase).toBe("headers");
      expect(result.error?.message).toContain("Failed to apply headers:");
      expect(result.error?.message).toContain("setExtraHTTPHeaders");
      expect(result.error?.step).toBeUndefined();
      expect(result.error?.action).toBeUndefined();
      expect(typeof result.duration).toBe("number");
      expect(result.flowName).toBe("headers-fail-to-apply");
    });

    it("does not run the flow's steps when headers fail to apply", async () => {
      const flow: FlowSpec = {
        name: "headers-fail-short-circuits",
        description:
          "A step that would fail with a distinctive message must never run",
        steps: [
          { visit: "/echo-header" },
          { click: "Nonexistent Element ZZZ" },
        ],
        expect: [{ visible: "No header received" }],
      };

      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        headers: { "bad header": "x" },
      });

      expect(result.success).toBe(false);
      expect(result.error?.message).not.toContain("Nonexistent Element ZZZ");
      expect(result.error?.phase).toBe("headers");
    });
  });

  describe("no-headers regression (byte-identical to pre-headers behavior)", () => {
    it("a successful flow with no headers option returns only success/flowName/duration", async () => {
      const flow: FlowSpec = {
        name: "no-headers-success",
        description: "No headers option supplied",
        steps: [{ visit: "/login.html" }],
        expect: [{ visible: "Sign In" }],
      };

      const result = await runFlow(flow, { baseUrl: server.baseUrl });

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(Object.keys(result).sort()).toEqual(
        ["duration", "flowName", "success"].sort(),
      );
    });

    it("an empty headers object behaves exactly like no headers at all", async () => {
      const flow: FlowSpec = {
        name: "empty-headers",
        description: "An empty record must not change what the server sees",
        steps: [{ visit: "/echo-header" }],
        expect: [{ visible: "No header received" }],
      };

      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        headers: {},
      });

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(Object.keys(result).sort()).toEqual(
        ["duration", "flowName", "success"].sort(),
      );
    });
  });
});
