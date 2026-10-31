import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseFlowSpec } from "../src/parser";
import { type RunnerOptions, runFlow } from "../src/runner";
import type { FlowResult } from "../src/types";
import {
  BUY_SCOPE,
  createSiloFixture,
  ISSUED_TOKEN,
  LONG_TEXT_BODY,
  PLATFORM_PACKAGES_PATH,
  QUOTE_SCOPE,
  SHOPIFY_PENDING_POLLS,
} from "./api-server";

/**
 * Runner tests for `surface: api`, executed through runFlow (the same
 * dispatch `flowspec run` uses) against the silo fixture servers. Every
 * request-count claim is read from porter's own server-side counter.
 */

const QUOTE_KEY = "key_quote_only_0001";
const BUY_KEY = "key_quote_and_buy_0002";

const fixture = createSiloFixture({
  keys: { [QUOTE_KEY]: [QUOTE_SCOPE], [BUY_KEY]: [QUOTE_SCOPE, BUY_SCOPE] },
});

const ENV_NAMES = ["API_TEST_BUY_KEY", "API_TEST_PLATFORM_URL", "API_TEST_TAG"];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  await fixture.start();
  for (const name of ENV_NAMES) {
    savedEnv[name] = process.env[name];
  }
  process.env.API_TEST_BUY_KEY = BUY_KEY;
  process.env.API_TEST_PLATFORM_URL = fixture.platformUrl;
  process.env.API_TEST_TAG = "tag-value-123";
});

afterAll(async () => {
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = savedEnv[name];
    }
  }
  await fixture.stop();
});

beforeEach(() => {
  fixture.resetObservations();
});

function run(yaml: string, options: RunnerOptions = {}): Promise<FlowResult> {
  return runFlow(parseFlowSpec(yaml), {
    baseUrl: fixture.porterUrl,
    timeout: 2000,
    ...options,
  });
}

function flow(steps: string, flowExpect = ""): string {
  return `
name: api-test
description: api runner test
surface: api
steps:
${steps}
${flowExpect ? `expect:\n${flowExpect}` : ""}
`;
}

describe("per-step and flow-level expect", () => {
  it("checks each step's expect against that step's own response", async () => {
    const result = await run(
      flow(`
  - request: {get: /__test/echo/first}
    expect:
      - json: {path: "$.path", equals: "/__test/echo/first"}
  - request: {get: /__test/echo/second}
    expect:
      - json: {path: "$.path", equals: "/__test/echo/second"}
`),
    );
    expect(result.error?.message).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it("fails at the step whose own response does not match, and runs no later step", async () => {
    const result = await run(
      flow(`
  - request: {get: /__test/echo/first}
    expect:
      - json: {path: "$.path", equals: "/__test/echo/second"}
  - request: {get: /__test/echo/second}
    expect:
      - status: 200
`),
      { timeout: 0 },
    );
    expect(result.success).toBe(false);
    expect(result.error?.step).toBe(0);
    expect(result.error?.message).toContain(
      'json $.path expected "/__test/echo/second" but got "/__test/echo/first"',
    );
    expect(fixture.requestCount("GET", "/__test/echo/second")).toBe(0);
  });

  it("applies flow-level expect to the last step, in addition to its own expect", async () => {
    const steps = `
  - request: {get: /__test/echo/first}
    expect:
      - status: 200
  - request: {get: /__test/echo/last}
    expect:
      - status: 200
`;
    const passing = await run(
      flow(steps, `  - json: {path: "$.path", equals: "/__test/echo/last"}`),
    );
    expect(passing.success).toBe(true);

    const failing = await run(
      flow(steps, `  - json: {path: "$.path", equals: "/__test/echo/first"}`),
      { timeout: 0 },
    );
    expect(failing.success).toBe(false);
    expect(failing.error?.step).toBe(1);
    expect(failing.error?.message).toContain("/__test/echo/first");
  });
});

describe("templates", () => {
  it("substitute captures and env into path, query, headers, json and assertion values, keeping types", async () => {
    const result = await run(
      flow(`
  - request:
      post: /__test/echo/seed
      json: {orderId: 576001, shop: "arcane", tags: ["a", "b"]}
    capture:
      order_id: "$.body.orderId"
      shop: "$.body.shop"
      tags: "$.body.tags"
    expect:
      - status: 200
  - request:
      post: "/__test/echo/{shop}/orders/{order_id}"
      query: {order: "{order_id}", literal: "{{order_id}}"}
      headers:
        X-Order: "order-{order_id}"
        Authorization: "Bearer {env.API_TEST_BUY_KEY}"
      json:
        id: "{order_id}"
        idString: "id-{order_id}"
        tags: "{tags}"
        nested: [{shop: "{shop}"}]
    expect:
      - json: {path: "$.path", equals: "/__test/echo/arcane/orders/576001"}
      - json: {path: "$.query.order", equals: "576001"}
      - json: {path: "$.query.literal", equals: "{{order_id}}"}
      - header: {name: "x-echo-method", equals: "POST"}
      - json: {path: "$.headers.x-order", equals: "order-576001"}
      - json: {path: "$.headers.authorization", equals: "Bearer {env.API_TEST_BUY_KEY}"}
      - json: {path: "$.body.id", equals: "{order_id}"}
      - json: {path: "$.body.id", equals: 576001}
      - json: {path: "$.body.idString", equals: "id-576001"}
      - json: {path: "$.body.tags", equals: ["a", "b"]}
      - json: {path: "$.body.nested.0.shop", in: ["other", "{shop}"]}
`),
    );
    expect(result.error?.message).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it("templates a raw body string and leaves JSON-looking braces alone", async () => {
    const result = await run(
      flow(`
  - request:
      post: /__test/echo/raw
      headers: {Content-Type: text/plain}
      body: '{"tag": "{env.API_TEST_TAG}", "x": 1}'
    expect:
      - json: {path: "$.body", equals: '{"tag": "tag-value-123", "x": 1}'}
`),
    );
    expect(result.error?.message).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it("fails a step that uses a variable not captured yet, naming it, without sending the request", async () => {
    const result = await run(
      flow(`
  - request: {post: "/__test/echo/labels/{package_id}"}
    expect:
      - status: 200
`),
    );
    expect(result.success).toBe(false);
    expect(result.error?.step).toBe(0);
    expect(result.error?.message).toContain(
      'Variable "{package_id}" has not been captured',
    );
    expect(
      fixture.requestCount("POST", "/__test/echo/labels/{package_id}"),
    ).toBe(0);
  });

  it("fails a step when a variable in an assertion value is missing, before sending", async () => {
    const result = await run(
      flow(`
  - request: {post: /__test/echo/buy}
    expect:
      - json: {path: "$.path", equals: "{never_captured}"}
`),
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('"{never_captured}"');
    expect(fixture.requestCount("POST", "/__test/echo/buy")).toBe(0);
  });

  it("fails a step whose capture path does not resolve, naming the variable and path, and runs no later step", async () => {
    const result = await run(
      flow(`
  - request: {get: /__test/echo/one}
    capture: {package_id: "$.body.packageId"}
    expect:
      - status: 200
  - request: {get: "/__test/echo/two/{package_id}"}
    expect:
      - status: 200
`),
    );
    expect(result.success).toBe(false);
    expect(result.error?.step).toBe(0);
    expect(result.error?.message).toContain(
      'Capture "package_id" failed: path "$.body.packageId" was not found',
    );
    expect(fixture.requestCount("GET", "/__test/echo/one")).toBe(1);
  });

  it("fails an embedded object reference, naming the variable", async () => {
    const result = await run(
      flow(`
  - request: {post: /__test/echo/obj, json: {a: {b: 1}}}
    capture: {obj: "$.body.a"}
    expect:
      - status: 200
  - request: {get: "/__test/echo/{obj}"}
    expect:
      - status: 200
`),
    );
    expect(result.success).toBe(false);
    expect(result.error?.step).toBe(1);
    expect(result.error?.message).toContain('"{obj}" holds an object');
  });

  it("fails before any request when an env reference is unset", async () => {
    delete process.env.API_TEST_UNSET_KEY;
    const result = await run(
      flow(`
  - request: {post: /__test/tokens}
    expect:
      - status: 201
  - request:
      get: /__test/whoami
      headers: {Authorization: "Bearer {env.API_TEST_UNSET_KEY}"}
    expect:
      - status: 200
`),
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain(
      'Environment variable "API_TEST_UNSET_KEY" is not set',
    );
    expect(fixture.requestCount("POST", "/__test/tokens")).toBe(0);
  });
});

describe("strict comparison", () => {
  const quote = (assertion: string) =>
    flow(`
  - request:
      post: /tiktok/arcane/labels/quote
      headers: {Authorization: "Bearer {env.API_TEST_BUY_KEY}"}
      json: {orderIds: ["576001"], weight: {value: "1.2", unit: "LB"}}
    expect:
      - ${assertion}
`);

  it('equals: "1.25" fails against the number 1.25', async () => {
    const result = await run(
      quote(`json: {path: "$.amountNumber", equals: "1.25"}`),
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain(
      'json $.amountNumber expected "1.25" (string) but got 1.25 (number)',
    );
  });

  it('equals: 1.25 fails against the string "1.25"', async () => {
    const result = await run(quote(`json: {path: "$.amount", equals: 1.25}`));
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain(
      'json $.amount expected 1.25 (number) but got "1.25" (string)',
    );
  });

  it("matching types pass", async () => {
    const result = await run(
      flow(`
  - request:
      post: /tiktok/arcane/labels/quote
      headers: {Authorization: "Bearer {env.API_TEST_BUY_KEY}"}
      json: {orderIds: ["576001"], weight: {value: "1.2", unit: "LB"}}
    expect:
      - json: {path: "$.amount", equals: "1.25"}
      - json: {path: "$.amountNumber", equals: 1.25}
      - json: {path: "$.amount", in: [1.25, "1.25"]}
`),
    );
    expect(result.error?.message).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it("in uses the same strict comparison", async () => {
    const result = await run(
      quote(`json: {path: "$.amount", in: [1.25, 125]}`),
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain(
      'json $.amount expected one of [1.25,125] but got "1.25"',
    );
  });
});

describe("retries", () => {
  it("sends a POST once when its assertion fails, even with a retry budget", async () => {
    const result = await run(
      flow(`
  - request: {post: /__test/tokens}
    expect:
      - status: 200
`),
      { timeout: 1500 },
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("Expected status 200 but got 201");
    expect(fixture.requestCount("POST", "/__test/tokens")).toBe(1);
  });

  it("sends PUT, PATCH and DELETE once when their assertions fail", async () => {
    for (const method of ["put", "patch", "delete"]) {
      const result = await run(
        flow(`
  - request: {${method}: /__test/echo/once}
    expect:
      - status: 204
`),
        { timeout: 1000 },
      );
      expect(result.success).toBe(false);
      expect(
        fixture.requestCount(method.toUpperCase(), "/__test/echo/once"),
      ).toBe(1);
    }
  });

  it("re-sends a GET until its assertions pass and captures from the passing response", async () => {
    const result = await run(
      flow(`
  - request: {get: /__test/sequence/poll-capture}
    capture: {n: "$.n"}
    expect:
      - json: {path: "$.ready", equals: true}
  - request: {post: /__test/echo/check, json: {n: "{n}"}}
    expect:
      - json: {path: "$.body.n", equals: 3}
`),
      { timeout: 3000 },
    );
    expect(result.error?.message).toBeUndefined();
    expect(result.success).toBe(true);
    expect(fixture.requestCount("GET", "/__test/sequence/poll-capture")).toBe(
      3,
    );
  });

  it("re-checks status on each poll, so a 202 that becomes 200 passes", async () => {
    const result = await run(
      flow(`
  - request:
      post: /shopify/arcane/labels
      headers: {Authorization: "Bearer {env.API_TEST_BUY_KEY}"}
    capture: {label_id: "$.labelId"}
    expect:
      - status: 202
  - request:
      get: "/shopify/arcane/labels/{label_id}"
      headers: {Authorization: "Bearer {env.API_TEST_BUY_KEY}"}
    expect:
      - status: 200
      - json: {path: "$.status", equals: "PURCHASED"}
`),
      { timeout: 3000 },
    );
    expect(result.error?.message).toBeUndefined();
    expect(result.success).toBe(true);
    expect(fixture.requestCount("POST", "/shopify/arcane/labels")).toBe(1);
    expect(fixture.requestCount("GET", "/shopify/arcane/labels/lbl_1")).toBe(
      SHOPIFY_PENDING_POLLS + 1,
    );
  });

  it("fails a GET once its budget expires, after more than one request", async () => {
    const started = Date.now();
    const result = await run(
      flow(`
  - request: {get: /__test/sequence/never-enough}
    timeout: 400
    expect:
      - json: {path: "$.n", equals: 100}
`),
      { timeout: 10000 },
    );
    const elapsed = Date.now() - started;
    expect(result.success).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(3000);
    expect(
      fixture.requestCount("GET", "/__test/sequence/never-enough"),
    ).toBeGreaterThan(1);
  });

  it("with timeout: 0 sends one GET and fails at once", async () => {
    const started = Date.now();
    const result = await run(
      flow(`
  - request: {get: /__test/sequence/immediate}
    timeout: 0
    expect:
      - json: {path: "$.ready", equals: true}
`),
      { timeout: 10000 },
    );
    expect(result.success).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(fixture.requestCount("GET", "/__test/sequence/immediate")).toBe(1);
  });

  it("uses the run timeout as the budget when the step has none", async () => {
    const result = await run(
      flow(`
  - request: {get: /__test/sequence/run-budget}
    expect:
      - json: {path: "$.ready", equals: true}
`),
      { timeout: 0 },
    );
    expect(result.success).toBe(false);
    expect(fixture.requestCount("GET", "/__test/sequence/run-budget")).toBe(1);
  });

  it("checks latency_under against the response that passed", async () => {
    const result = await run(
      flow(`
  - request: {get: "/__test/warming?key=retry&ms=400"}
    expect:
      - latency_under: 200
`),
      { timeout: 3000 },
    );
    expect(result.error?.message).toBeUndefined();
    expect(result.success).toBe(true);
    expect(fixture.requestCount("GET", "/__test/warming")).toBe(2);
  });

  it("fails latency_under on a slow first response with timeout: 0", async () => {
    const result = await run(
      flow(`
  - request: {get: "/__test/warming?key=strict&ms=400"}
    timeout: 0
    expect:
      - latency_under: 200
`),
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(
      /Response took \d+ms, expected under 200ms/,
    );
  });
});

describe("assertions", () => {
  it("json in, matches and exists pass and fail on the actual body", async () => {
    const passing = await run(
      flow(`
  - request: {post: /__test/echo/a, json: {status: "PURCHASED", id: "pkg_0001"}}
    expect:
      - json: {path: "$.body.status", in: ["PENDING", "PURCHASED"]}
      - json: {path: "$.body.id", matches: "^pkg_\\\\d{4}$"}
      - json: {path: "$.body.id", exists: true}
      - json: {path: "$.body.missing", exists: false}
`),
    );
    expect(passing.error?.message).toBeUndefined();
    expect(passing.success).toBe(true);

    const cases: [string, string][] = [
      [
        `json: {path: "$.body.status", in: ["PENDING"]}`,
        'json $.body.status expected one of ["PENDING"] but got "PURCHASED"',
      ],
      [
        `json: {path: "$.body.id", matches: "^lbl_"}`,
        'json $.body.id did not match pattern "^lbl_": got "pkg_0001"',
      ],
      [
        `json: {path: "$.body.n", matches: "1"}`,
        "json $.body.n is a number, but matches needs a string: got 1",
      ],
      [
        `json: {path: "$.body.missing", exists: true}`,
        "json $.body.missing does not exist",
      ],
      [
        `json: {path: "$.body.id", exists: false}`,
        'json $.body.id exists: got "pkg_0001"',
      ],
      [
        `json: {path: "$.body.missing", equals: 1}`,
        "json $.body.missing was not found in the response body",
      ],
    ];
    for (const [assertion, message] of cases) {
      const result = await run(
        flow(`
  - request: {post: /__test/echo/a, json: {status: "PURCHASED", id: "pkg_0001", n: 1}}
    expect:
      - ${assertion}
`),
      );
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain(message);
    }
  });

  it("header assertions match the name case-insensitively", async () => {
    const passing = await run(
      flow(`
  - request: {get: /__test/echo/h}
    expect:
      - header: {name: "X-ECHO-METHOD", equals: "GET"}
      - header: {name: "content-type", contains: "application/json"}
`),
    );
    expect(passing.error?.message).toBeUndefined();
    expect(passing.success).toBe(true);

    const missing = await run(
      flow(`
  - request: {get: /__test/echo/h}
    expect:
      - header: {name: "x-not-sent", equals: "x"}
`),
    );
    expect(missing.error?.message).toContain(
      'Response header "x-not-sent" is missing',
    );

    const wrong = await run(
      flow(`
  - request: {get: /__test/echo/h}
    expect:
      - header: {name: "x-echo-method", contains: "POST"}
`),
    );
    expect(wrong.error?.message).toContain(
      'Response header "x-echo-method" expected to contain "POST" but got "GET"',
    );
  });

  it("a json assertion on a non-JSON body fails and reports the first 500 bytes", async () => {
    const result = await run(
      flow(`
  - request: {get: /__test/text}
    expect:
      - json: {path: "$.a", exists: false}
`),
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("response body is not valid JSON");
    expect(result.error?.message).toContain(LONG_TEXT_BODY.slice(0, 500));
    expect(result.error?.message).not.toContain("TAIL-MARKER");
  });

  it("a status failure reports the response body", async () => {
    const result = await run(
      flow(`
  - request:
      post: /tiktok/arcane/labels
      headers: {Authorization: "Bearer ${QUOTE_KEY}"}
      json: {orderIds: ["576001"], weight: {value: "1.2", unit: "LB"}}
    expect:
      - status: 200
`),
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("Expected status 200 but got 403");
    expect(result.error?.message).toContain('"missingScope":"labels:buy"');
  });
});

describe("requests", () => {
  it("resolves relative paths against baseUrl and allows absolute URLs from env", async () => {
    const result = await run(
      flow(`
  - request: {post: "{env.API_TEST_PLATFORM_URL}/__reset"}
    expect:
      - json: {path: "$.reset", equals: true}
  - request: {get: "{env.API_TEST_PLATFORM_URL}/__calls?path=${PLATFORM_PACKAGES_PATH}"}
    expect:
      - json: {path: "$.count", equals: 0}
  - request: {get: "/__test/echo/relative"}
    expect:
      - json: {path: "$.path", equals: "/__test/echo/relative"}
`),
    );
    expect(result.error?.message).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it("sends json with Content-Type application/json unless the step overrides it", async () => {
    const result = await run(
      flow(`
  - request: {post: /__test/echo/ct, json: {a: 1}}
    expect:
      - json: {path: "$.contentType", equals: "application/json"}
  - request:
      post: /__test/echo/ct
      headers: {content-type: "application/merge-patch+json"}
      json: {a: 1}
    expect:
      - json: {path: "$.contentType", equals: "application/merge-patch+json"}
`),
    );
    expect(result.error?.message).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it("sends config headers only to baseUrl's origin by default, and step headers override them", async () => {
    const result = await run(
      flow(`
  - request: {get: /__test/echo/h}
    expect:
      - json: {path: "$.headers.x-config", equals: "from-config"}
  - request:
      get: /__test/echo/h
      headers: {X-CONFIG: "from-step"}
    expect:
      - json: {path: "$.headers.x-config", equals: "from-step"}
  - request: {get: "{env.API_TEST_PLATFORM_URL}/__echo"}
    expect:
      - json: {path: "$.headers.x-config", exists: false}
`),
      { headers: { "x-config": "from-config" } },
    );
    expect(result.error?.message).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it("sends config headers to every origin with headersScope: all", async () => {
    const result = await run(
      flow(`
  - request: {get: "{env.API_TEST_PLATFORM_URL}/__echo"}
    expect:
      - json: {path: "$.headers.x-config", equals: "from-config"}
`),
      { headers: { "x-config": "from-config" }, headersScope: "all" },
    );
    expect(result.error?.message).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it("sends a HEAD request and checks its status", async () => {
    const result = await run(
      flow(`
  - request: {head: /__test/echo/head}
    expect:
      - status: 200
`),
    );
    expect(result.success).toBe(true);
    expect(fixture.requestCount("HEAD", "/__test/echo/head")).toBe(1);
  });

  it("a wait step sleeps and sends nothing", async () => {
    const started = Date.now();
    const result = await run(
      flow(`
  - wait: 300
  - request: {get: /__test/echo/after-wait}
    expect:
      - status: 200
`),
    );
    expect(result.success).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  });

  it("reports a connection failure as a step failure", async () => {
    const result = await run(
      flow(`
  - request: {post: "http://127.0.0.1:1/unreachable"}
    expect:
      - status: 200
`),
    );
    expect(result.success).toBe(false);
    expect(result.error?.step).toBe(0);
    expect(result.error?.message).toContain("Request failed");
  });
});

describe("publicEnv", () => {
  it("leaves a public env value readable while a non-listed env value in the same flow is redacted", async () => {
    const result = await run(
      flow(`
  - request:
      get: "{env.API_TEST_PLATFORM_URL}/__echo"
      headers: {Authorization: "Bearer {env.API_TEST_BUY_KEY}"}
    timeout: 0
    expect:
      - json: {path: "$.headers.authorization", equals: "{env.API_TEST_PLATFORM_URL}"}
`),
      { publicEnv: ["API_TEST_PLATFORM_URL"] },
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain(
      `json $.headers.authorization expected "${fixture.platformUrl}" but got "Bearer [REDACTED:API_TEST_BUY_KEY]"`,
    );
    expect(result.error?.request?.url).toBe(`${fixture.platformUrl}/__echo`);
    expect(JSON.stringify(result)).not.toContain(BUY_KEY);
  });

  it("still fails before any request when a public env name is unset", async () => {
    delete process.env.API_TEST_UNSET_PUBLIC;
    const result = await run(
      flow(`
  - request: {post: /__test/tokens}
    expect:
      - status: 201
  - request: {get: "/__test/echo/{env.API_TEST_UNSET_PUBLIC}"}
    expect:
      - status: 200
`),
      { publicEnv: ["API_TEST_UNSET_PUBLIC"] },
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain(
      'Environment variable "API_TEST_UNSET_PUBLIC" is not set',
    );
    expect(fixture.requestCount("POST", "/__test/tokens")).toBe(0);
  });
});

describe("recorded request and response", () => {
  it("records config header names but not their values, and a step's own override in full", async () => {
    const result = await run(
      flow(`
  - request:
      get: /__test/echo/h
      headers: {X-Step: "step-value"}
    timeout: 0
    expect:
      - status: 201
`),
      { headers: { "x-config": "config-token-value", "x-step": "replaced" } },
    );
    expect(result.success).toBe(false);
    expect(result.error?.request?.headers["x-config"]).toBe("[config header]");
    expect(result.error?.request?.headers["x-step"]).toBe("step-value");
    expect(JSON.stringify(result.error?.request)).not.toContain(
      "config-token-value",
    );
  });

  it("redacts a secret capture's value from the response of a step that failed before capturing", async () => {
    const result = await run(
      flow(`
  - request: {post: /__test/tokens}
    capture: {token: {path: "$.token", secret: true}}
    expect:
      - status: 200
`),
    );
    expect(result.success).toBe(false);
    expect(result.error?.response?.body).toBe('{"token":"[REDACTED:token]"}');
    expect(JSON.stringify(result)).not.toContain(ISSUED_TOKEN);
  });

  it("attaches the request and response of a failing step, with env values redacted", async () => {
    const result = await run(
      flow(`
  - request:
      post: /tiktok/arcane/labels
      headers: {Authorization: "Bearer {env.API_TEST_BUY_KEY}"}
      json: {orderIds: ["576001"], weight: {value: 1.2, unit: "LB"}}
    expect:
      - status: 200
`),
    );
    expect(result.success).toBe(false);
    expect(result.error?.request?.method).toBe("POST");
    expect(result.error?.request?.url).toBe(
      `${fixture.porterUrl}/tiktok/arcane/labels`,
    );
    expect(result.error?.request?.headers.authorization).toBe(
      "Bearer [REDACTED:API_TEST_BUY_KEY]",
    );
    expect(result.error?.request?.body).toContain('"value":1.2');
    expect(result.error?.response?.status).toBe(422);
    expect(result.error?.response?.body).toContain(
      "weight.value must be a string",
    );
    expect(JSON.stringify(result)).not.toContain(BUY_KEY);
  });
});
