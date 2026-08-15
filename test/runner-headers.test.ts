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

/**
 * A second server instance on a distinct port is a distinct ORIGIN as far as
 * the browser is concerned, which is what makes header leakage observable.
 * The rest of the suite uses the default 3456; 3466 is picked to stay clear
 * of it and of any other fixture server.
 */
const CROSS_ORIGIN_PORT = 3466;

/** Build a probe URL that fetches `target` as a cross-origin subresource. */
function probePath(target: string): string {
  return `/cross-origin-probe?target=${encodeURIComponent(target)}`;
}

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

  describe("header values containing quotes", () => {
    /**
     * Header values are shipped to agent-browser as a JSON document. Any
     * quote-mangling on the way corrupts that JSON, so these tests prove the
     * value arrives at the *server* byte-for-byte — the strongest available
     * evidence that nothing rewrote it in transit.
     *
     * One wrinkle: page-text assertions read agent-browser's accessibility
     * snapshot, whose YAML rendering re-escapes quote characters inside a
     * quoted node label — an apostrophe is doubled ('' ) and a double quote is
     * backslash-escaped. That escaping happens on the way *out* of the page,
     * long after the header was sent, so the patterns below tolerate it while
     * still pinning every other byte. Corrupted values do not match: the
     * shell-escaped form is `it'"'"'s`, which no pattern here accepts, and the
     * companion assertion below rejects it explicitly.
     */

    it("sends a header value containing a single quote verbatim", async () => {
      const flow: FlowSpec = {
        name: "header-single-quote",
        description: "An apostrophe in a token must reach the server intact",
        steps: [{ visit: "/echo-header" }],
        // `it'{1,2}s` accepts the snapshot's doubled apostrophe, nothing else.
        expect: [{ matches: "Header: Bearer it'{1,2}s-a-token" }],
      };

      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        headers: { "x-flowspec-test": "Bearer it's-a-token" },
        timeout: 0,
      });

      expect(result.success).toBe(true);
    });

    it("does not leave POSIX quote-escaping artifacts in the header value", async () => {
      const flow: FlowSpec = {
        name: "header-no-escaping-artifacts",
        description:
          "The '\\'' shell-escaping idiom must never reach the server",
        steps: [{ visit: "/echo-header" }],
        expect: [{ not_visible: `it'"'"'s` }],
      };

      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        headers: { "x-flowspec-test": "Bearer it's-a-token" },
        timeout: 0,
      });

      expect(result.success).toBe(true);
    });

    it("sends a header value containing double quotes and spaces verbatim", async () => {
      const flow: FlowSpec = {
        name: "header-double-quotes",
        description: "Double quotes and spaces survive (regression)",
        steps: [{ visit: "/echo-header" }],
        // `\\?"` accepts the snapshot's backslash-escaped double quote.
        expect: [{ matches: 'Header: token \\\\?"quoted value\\\\?" here' }],
      };

      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        headers: { "x-flowspec-test": 'token "quoted value" here' },
        timeout: 0,
      });

      expect(result.success).toBe(true);
    });

    it("sends a header value containing shell metacharacters verbatim", async () => {
      const flow: FlowSpec = {
        name: "header-shell-metacharacters",
        description: "Injection-shaped values are just bytes to the browser",
        steps: [{ visit: "/echo-header" }],
        expect: [{ visible: "Header: $(whoami) `id`" }],
      };

      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        headers: { "x-flowspec-test": "$(whoami) `id`" },
        timeout: 0,
      });

      expect(result.success).toBe(true);
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
      // The message has to name the header the user must go fix. It used to
      // quote Playwright's setExtraHTTPHeaders error verbatim; malformed
      // headers are now caught before any browser command runs, because the
      // origin-scoped path applies headers through a request route whose
      // handler throws on a bad name — leaving the navigation hanging forever
      // instead of failing. Naming the header is the stronger message either
      // way.
      expect(result.error?.message).toContain('"bad header"');
      expect(result.error?.step).toBeUndefined();
      expect(result.error?.action).toBeUndefined();
      expect(typeof result.duration).toBe("number");
      expect(result.flowName).toBe("headers-fail-to-apply");
    });

    it("rejects a malformed header under scope 'all' too, so the opt-in path keeps the same guard", async () => {
      const flow: FlowSpec = {
        name: "headers-fail-to-apply-scope-all",
        description: "Context-wide headers are validated the same way",
        steps: [{ visit: "/echo-header" }],
        expect: [{ visible: "No header received" }],
      };

      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        headers: { "bad header": "x" },
        headersScope: "all",
      });

      expect(result.success).toBe(false);
      expect(result.error?.phase).toBe("headers");
      expect(result.error?.message).toContain("Failed to apply headers:");
      expect(result.error?.message).toContain('"bad header"');
    });

    it("rejects a header value carrying a CRLF injection attempt", async () => {
      const flow: FlowSpec = {
        name: "headers-crlf-injection",
        description:
          "A value that would smuggle a second header must be refused",
        steps: [{ visit: "/echo-header" }],
        expect: [{ visible: "No header received" }],
      };

      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        headers: { "x-flowspec-test": "ok\r\nx-injected: evil" },
      });

      expect(result.success).toBe(false);
      expect(result.error?.phase).toBe("headers");
      expect(result.error?.message).toContain("Failed to apply headers:");
      expect(result.error?.message).toContain('"x-flowspec-test"');
    });

    it("fails fast on a malformed header instead of hanging on a navigation", async () => {
      const flow: FlowSpec = {
        name: "headers-fail-fast",
        description: "Malformed headers are refused before any navigation",
        steps: [{ visit: "/echo-header" }],
        expect: [{ visible: "No header received" }],
      };

      const result = await runFlow(flow, {
        baseUrl: server.baseUrl,
        headers: { "bad header": "x" },
      });

      expect(result.success).toBe(false);
      // The origin-scoped mechanism applies headers via a request route; a
      // malformed name makes that route's handler throw mid-flight and the
      // navigation never settles. The bound is loose on purpose — it is
      // separating "checked up front" from "hangs indefinitely", not timing.
      expect(result.duration).toBeLessThan(10000);
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

/**
 * Origin scoping.
 *
 * Two fixture servers on two ports are two origins. Origin A is the flow's
 * baseUrl — the deployment the token belongs to. Origin B stands in for every
 * third party a real page talks to: a CDN, an analytics pixel, a font host.
 *
 * The leak these tests exist to prevent: a context-wide header rides along to
 * B as well, handing a bypass token to a host that has no business holding
 * one. /cross-origin-probe makes that observable — the page fetches B as a
 * subresource, and B records what it received.
 *
 * Empirically determined against agent-browser (see applyHeaders/visitHeaderArgs
 * in src/runner.ts): the global `--headers <json>` option registers a route
 * interception scoped to the OPENED URL's host, it persists for the rest of
 * the session, and it never touches other hosts.
 */
describeIfAgentBrowser("Flow Runner header origin scoping", () => {
  let originA: TestServer;
  let originB: TestServer;

  beforeAll(async () => {
    originA = createTestServer();
    originB = createTestServer({ port: CROSS_ORIGIN_PORT });
    await originA.start();
    await originB.start();
  });

  afterAll(async () => {
    await originA.stop();
    await originB.stop();
  });

  /** Clear both recorders so "Recorded: none" can never be a stale reading. */
  async function resetRecorders(): Promise<void> {
    await fetch(`${originA.baseUrl}/reset-recorded-header`);
    await fetch(`${originB.baseUrl}/reset-recorded-header`);
  }

  describe("default scope (no headersScope option)", () => {
    it("does not leak the header to a cross-origin subresource, nor to a cross-origin navigation, while still sending it to baseUrl's origin", async () => {
      await resetRecorders();

      const flow: FlowSpec = {
        name: "origin-scoped-by-default",
        description:
          "One flow, three proofs: B's subresource fetch carried nothing, " +
          "a direct navigation to B carried nothing, and A still got the header",
        steps: [
          // 1. A page on origin A fetches origin B as a subresource.
          { visit: probePath(`${originB.baseUrl}/record-header`) },
          { wait_for: "probe complete" },
          // 2. Origin A itself still receives the header.
          { visit: "/echo-header" },
          { wait_for: "Header: granted" },
          // 3. Navigating straight to origin B carries nothing either.
          { visit: `${originB.baseUrl}/echo-header` },
          { wait_for: "No header received" },
          // 4. And B's record of the step-1 subresource says the same.
          { visit: `${originB.baseUrl}/recorded-header` },
        ],
        expect: [{ visible: "Recorded: none" }],
      };

      const result = await runFlow(flow, {
        baseUrl: originA.baseUrl,
        headers: { "x-flowspec-test": "granted" },
        timeout: 2000,
      });

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
    });

    it("still sends the header to same-origin subresources (the point of having headers at all)", async () => {
      await resetRecorders();

      const flow: FlowSpec = {
        name: "origin-scope-covers-same-origin-subresources",
        description:
          "A page-level fetch back to baseUrl's own origin must carry the header",
        steps: [
          { visit: probePath(`${originA.baseUrl}/record-header`) },
          { wait_for: "probe complete" },
          { visit: "/recorded-header" },
        ],
        expect: [{ visible: "Recorded: granted" }],
      };

      const result = await runFlow(flow, {
        baseUrl: originA.baseUrl,
        headers: { "x-flowspec-test": "granted" },
        timeout: 2000,
      });

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
    });

    it('behaves identically when scope "origin" is requested explicitly', async () => {
      await resetRecorders();

      const flow: FlowSpec = {
        name: "explicit-origin-scope",
        description: "Explicit origin scope matches the default",
        steps: [
          { visit: probePath(`${originB.baseUrl}/record-header`) },
          { wait_for: "probe complete" },
          { visit: `${originB.baseUrl}/recorded-header` },
        ],
        expect: [{ visible: "Recorded: none" }],
      };

      const result = await runFlow(flow, {
        baseUrl: originA.baseUrl,
        headers: { "x-flowspec-test": "granted" },
        headersScope: "origin",
        timeout: 2000,
      });

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
    });
  });

  describe('scope "all" (opt-in, context-wide)', () => {
    it("sends the header to a cross-origin subresource, proving the escape hatch is genuinely context-wide", async () => {
      await resetRecorders();

      const flow: FlowSpec = {
        name: "all-scope-reaches-other-origins",
        description: "Opting in to context-wide headers reaches origin B",
        steps: [
          { visit: probePath(`${originB.baseUrl}/record-header`) },
          { wait_for: "probe complete" },
          { visit: `${originB.baseUrl}/recorded-header` },
        ],
        expect: [{ visible: "Recorded: granted" }],
      };

      const result = await runFlow(flow, {
        baseUrl: originA.baseUrl,
        headers: { "x-flowspec-test": "granted" },
        headersScope: "all",
        timeout: 2000,
      });

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
    });

    it("still sends the header to baseUrl's own origin (no regression on the original behavior)", async () => {
      const flow: FlowSpec = {
        name: "all-scope-covers-base-origin",
        description: "The opt-in path keeps working for the deployment itself",
        steps: [{ visit: "/echo-header" }],
        expect: [{ visible: "Header: granted" }],
      };

      const result = await runFlow(flow, {
        baseUrl: originA.baseUrl,
        headers: { "x-flowspec-test": "granted" },
        headersScope: "all",
        timeout: 2000,
      });

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
    });
  });
});
