import { describe, expect, it } from "vitest";
import { parseFlowSpec } from "../src/parser";
import { asApiFlow, FlowSpecSchema } from "../src/types";

/**
 * Schema tests for the `surface: api` grammar (issue #8): request/wait steps,
 * per-step expect and capture, the api assertion vocabulary, and the
 * parse-time rules (one method per request, json xor body, timeout only on
 * GET/HEAD, flow-level expect needs a final request step).
 */

function issueMessages(
  result: ReturnType<typeof FlowSpecSchema.safeParse>,
): string {
  return result.success
    ? ""
    : result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join(" | ");
}

function apiFlow(overrides: Record<string, unknown> = {}) {
  return {
    name: "api-flow",
    description: "An api flow",
    surface: "api",
    steps: [{ request: { get: "/health" }, expect: [{ status: 200 }] }],
    ...overrides,
  };
}

function requestStep(step: Record<string, unknown>) {
  return apiFlow({ steps: [step] });
}

describe("surface: api parses", () => {
  it("accepts the issue's idempotency example", () => {
    const flow = parseFlowSpec(`
name: label-buy-is-idempotent
description: A replayed buy returns the first result without calling the platform again
surface: api
steps:
  - request:
      post: /tiktok/arcane/labels
      headers:
        Authorization: "Bearer {env.PORTER_BUY_KEY}"
        Idempotency-Key: e2e-buy-1
      json: {orderIds: ["576001"], weight: {value: "1.2", unit: "LB"}}
    capture: {package_id: "$.packageId"}
    expect:
      - status: 200
  - request:
      post: /tiktok/arcane/labels
      headers:
        Authorization: "Bearer {env.PORTER_BUY_KEY}"
        Idempotency-Key: e2e-buy-1
      json: {orderIds: ["576001"], weight: {value: "1.2", unit: "LB"}}
    expect:
      - status: 200
      - json: {path: "$.packageId", equals: "{package_id}"}
  - request: {get: "{env.PLATFORM_FAKE_URL}/__calls?path=/fulfillment/202309/packages"}
expect:
  - json: {path: "$.count", equals: 1}
`);
    expect(flow.surface).toBe("api");
    expect(flow.steps).toHaveLength(3);
    expect(flow.expect).toEqual([{ json: { path: "$.count", equals: 1 } }]);
  });

  it("accepts every method key", () => {
    for (const method of ["get", "head", "post", "put", "patch", "delete"]) {
      const result = FlowSpecSchema.safeParse(
        requestStep({ request: { [method]: "/x" }, expect: [{ status: 200 }] }),
      );
      expect(issueMessages(result)).toBe("");
    }
  });

  it("accepts headers, query, body, wait steps, secret captures and every assertion", () => {
    const result = FlowSpecSchema.safeParse(
      apiFlow({
        steps: [
          {
            request: {
              post: "/tokens",
              headers: { "X-Trace": "abc" },
              query: { page: 2, dry: true, q: "x" },
              body: '{"a": 1}',
            },
            capture: {
              plain: "$.id",
              token: { path: "$.token", secret: true },
            },
            expect: [
              { status: 201 },
              { json: { path: "$.id", equals: 3 } },
              { json: { path: "$.kind", in: ["a", "b"] } },
              { json: { path: "$.token", matches: "^tok_" } },
              { json: { path: "$.gone", exists: false } },
              { header: { name: "content-type", contains: "json" } },
              { header: { name: "x-request-id", equals: "r1" } },
              { latency_under: 500 },
            ],
          },
          { wait: 100 },
          { request: { get: "/x" }, timeout: 0, expect: [{ status: 200 }] },
        ],
      }),
    );
    expect(issueMessages(result)).toBe("");
  });

  it("allows flow-level expect only, with no step-level expect", () => {
    const result = FlowSpecSchema.safeParse(
      apiFlow({
        steps: [{ request: { get: "/x" } }],
        expect: [{ status: 200 }],
      }),
    );
    expect(issueMessages(result)).toBe("");
  });

  it("narrows to an ApiFlowSpec", () => {
    const flow = FlowSpecSchema.parse(apiFlow());
    expect(asApiFlow(flow).surface).toBe("api");
  });
});

describe("surface: api rejects", () => {
  it("web and cli verbs, naming the verb and surface", () => {
    for (const [step, verb] of [
      [{ visit: "/x" }, "visit"],
      [{ click: "Go" }, "click"],
      [{ run: "ls" }, "run"],
    ] as const) {
      const result = FlowSpecSchema.safeParse(
        apiFlow({ steps: [step], expect: [{ status: 200 }] }),
      );
      expect(issueMessages(result)).toContain(
        `Step verb "${verb}" is not valid for surface "api"`,
      );
    }
  });

  it("web and cli assertions, naming the assertion and surface", () => {
    for (const [assertion, verb] of [
      [{ visible: "Hi" }, "visible"],
      [{ exit_code: 0 }, "exit_code"],
    ] as const) {
      const flowLevel = FlowSpecSchema.safeParse(
        apiFlow({ steps: [{ request: { get: "/x" } }], expect: [assertion] }),
      );
      expect(issueMessages(flowLevel)).toContain(
        `Assertion "${verb}" is not valid for surface "api"`,
      );

      const stepLevel = FlowSpecSchema.safeParse(
        requestStep({ request: { get: "/x" }, expect: [assertion] }),
      );
      expect(issueMessages(stepLevel)).toContain(
        `Assertion "${verb}" is not valid for surface "api"`,
      );
    }
  });

  it("a request step in a web or cli flow, naming the verb and surface", () => {
    const web = FlowSpecSchema.safeParse({
      name: "w",
      description: "w",
      steps: [{ request: { get: "/x" } }],
      expect: [{ visible: "x" }],
    });
    expect(issueMessages(web)).toContain(
      'Step verb "request" is not valid for surface "web"',
    );

    const cli = FlowSpecSchema.safeParse({
      name: "c",
      description: "c",
      surface: "cli",
      steps: [{ request: { get: "/x" } }],
      expect: [{ exit_code: 0 }],
    });
    expect(issueMessages(cli)).toContain(
      'Step verb "request" is not valid for surface "cli"',
    );
  });

  it("a request with no method or two methods", () => {
    const none = FlowSpecSchema.safeParse(
      requestStep({ request: { headers: {} }, expect: [{ status: 200 }] }),
    );
    expect(issueMessages(none)).toContain(
      "request must have exactly one method key",
    );

    const two = FlowSpecSchema.safeParse(
      requestStep({
        request: { get: "/a", post: "/b" },
        expect: [{ status: 200 }],
      }),
    );
    expect(issueMessages(two)).toContain(
      "request must have exactly one method key",
    );
  });

  it("an unknown request key or step key", () => {
    const requestKey = FlowSpecSchema.safeParse(
      requestStep({
        request: { get: "/a", form: { a: 1 } },
        expect: [{ status: 200 }],
      }),
    );
    expect(issueMessages(requestKey)).toContain("form");

    const stepKey = FlowSpecSchema.safeParse(
      requestStep({
        request: { get: "/a" },
        retries: 3,
        expect: [{ status: 200 }],
      }),
    );
    expect(issueMessages(stepKey)).toContain("retries");
  });

  it("json and body together", () => {
    const result = FlowSpecSchema.safeParse(
      requestStep({
        request: { post: "/a", json: { a: 1 }, body: "x" },
        expect: [{ status: 200 }],
      }),
    );
    expect(issueMessages(result)).toContain(
      "request may have json or body, not both",
    );
  });

  it("json or body on a GET or HEAD", () => {
    const result = FlowSpecSchema.safeParse(
      requestStep({
        request: { head: "/a", body: "x" },
        expect: [{ status: 200 }],
      }),
    );
    expect(issueMessages(result)).toContain(
      "a head request cannot have a body",
    );
  });

  it("timeout on a non-GET/HEAD step", () => {
    for (const method of ["post", "put", "patch", "delete"]) {
      const result = FlowSpecSchema.safeParse(
        requestStep({
          request: { [method]: "/a" },
          timeout: 1000,
          expect: [{ status: 200 }],
        }),
      );
      expect(issueMessages(result)).toContain(
        `timeout is only valid on GET and HEAD steps (this step is ${method.toUpperCase()}, which is sent once and never retried)`,
      );
    }
  });

  it("a negative timeout", () => {
    const result = FlowSpecSchema.safeParse(
      requestStep({
        request: { get: "/a" },
        timeout: -1,
        expect: [{ status: 200 }],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("a flow-level expect when the last step is a wait", () => {
    const result = FlowSpecSchema.safeParse(
      apiFlow({
        steps: [{ request: { get: "/a" } }, { wait: 10 }],
        expect: [{ status: 200 }],
      }),
    );
    expect(issueMessages(result)).toContain(
      "a flow-level expect applies to the last step, which must be a request",
    );
  });

  it("a flow with no assertions anywhere", () => {
    const result = FlowSpecSchema.safeParse(
      apiFlow({ steps: [{ request: { get: "/a" } }] }),
    );
    expect(issueMessages(result)).toContain(
      "expect must contain at least one assertion for surface api",
    );
  });

  it("a wait step carrying request modifiers", () => {
    const result = FlowSpecSchema.safeParse(
      apiFlow({
        steps: [
          { wait: 10, expect: [{ status: 200 }] },
          { request: { get: "/a" } },
        ],
        expect: [{ status: 200 }],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("a capture name that is not a valid variable name", () => {
    const result = FlowSpecSchema.safeParse(
      requestStep({
        request: { get: "/a" },
        capture: { "bad-name": "$.x" },
        expect: [{ status: 200 }],
      }),
    );
    expect(issueMessages(result)).toContain(
      'capture name "bad-name" must match [A-Za-z_][A-Za-z0-9_]*',
    );
  });

  it("a json assertion with zero or two comparisons", () => {
    const zero = FlowSpecSchema.safeParse(
      requestStep({
        request: { get: "/a" },
        expect: [{ json: { path: "$.a" } }],
      }),
    );
    expect(issueMessages(zero)).toContain(
      "json assertion needs exactly one of equals, in, matches, exists",
    );

    const two = FlowSpecSchema.safeParse(
      requestStep({
        request: { get: "/a" },
        expect: [{ json: { path: "$.a", equals: 1, exists: true } }],
      }),
    );
    expect(issueMessages(two)).toContain(
      "json assertion needs exactly one of equals, in, matches, exists",
    );
  });

  it("a json assertion with no path, and an uncompilable matches", () => {
    const noPath = FlowSpecSchema.safeParse(
      requestStep({
        request: { get: "/a" },
        expect: [{ json: { equals: 1 } }],
      }),
    );
    expect(issueMessages(noPath)).toContain(
      'Missing required key "path" in json',
    );

    const badRegex = FlowSpecSchema.safeParse(
      requestStep({
        request: { get: "/a" },
        expect: [{ json: { path: "$.a", matches: "(" } }],
      }),
    );
    expect(issueMessages(badRegex)).toContain('Invalid regex pattern "("');
  });

  it("a header assertion without exactly one of equals/contains", () => {
    const result = FlowSpecSchema.safeParse(
      requestStep({
        request: { get: "/a" },
        expect: [{ header: { name: "x-a" } }],
      }),
    );
    expect(issueMessages(result)).toContain(
      "header assertion needs exactly one of equals, contains",
    );
  });

  it("a non-integer status and a non-positive latency_under", () => {
    expect(
      FlowSpecSchema.safeParse(
        requestStep({ request: { get: "/a" }, expect: [{ status: "200" }] }),
      ).success,
    ).toBe(false);
    expect(
      FlowSpecSchema.safeParse(
        requestStep({ request: { get: "/a" }, expect: [{ latency_under: 0 }] }),
      ).success,
    ).toBe(false);
  });

  it("a flow-level setup block", () => {
    const result = FlowSpecSchema.safeParse(
      apiFlow({ setup: [{ request: { get: "/a" } }] }),
    );
    expect(issueMessages(result)).toContain(
      'setup is not supported for surface "api"',
    );
  });
});
