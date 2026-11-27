import { describe, expect, it } from "vitest";
import { formatError, formatResult } from "../src/reporter";
import type { FlowError, FlowResult } from "../src/types";

const apiError: FlowError = {
  message: "Expected status 200 but got 422",
  step: 1,
  action: {
    request: { post: "/tiktok/arcane/labels", json: { a: 1 } },
    expect: [{ status: 200 }],
  },
  request: {
    method: "POST",
    url: "http://127.0.0.1:4000/tiktok/arcane/labels",
    headers: {
      authorization: "Bearer [REDACTED:PORTER_BUY_KEY]",
      "content-type": "application/json",
    },
    body: '{"a":1}',
  },
  response: {
    status: 422,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: '{"error":"weight.value must be a string"}',
    latencyMs: 12,
  },
};

describe("api failure report", () => {
  it("formatResult names the step and prints the request and response", () => {
    const result: FlowResult = {
      success: false,
      flowName: "label-buy",
      duration: 40,
      error: apiError,
    };
    const lines = formatResult(result).split("\n");
    expect(lines.slice(1)).toEqual([
      "  Step 1: POST /tiktok/arcane/labels",
      "  Error: Expected status 200 but got 422",
      "  Request: POST http://127.0.0.1:4000/tiktok/arcane/labels",
      "    authorization: Bearer [REDACTED:PORTER_BUY_KEY]",
      "    content-type: application/json",
      '  Request body: {"a":1}',
      "  Response: 422 in 12ms",
      "    content-type: application/json; charset=utf-8",
      '  Response body: {"error":"weight.value must be a string"}',
    ]);
  });

  it("formatError prints the same request and response lines", () => {
    const text = formatError(apiError);
    expect(text).toContain("Step 1: POST /tiktok/arcane/labels");
    expect(text).toContain(
      "Request: POST http://127.0.0.1:4000/tiktok/arcane/labels",
    );
    expect(text).toContain("authorization: Bearer [REDACTED:PORTER_BUY_KEY]");
    expect(text).toContain("Response: 422 in 12ms");
  });

  it("omits request and response lines when a step failed before sending", () => {
    const text = formatResult({
      success: false,
      flowName: "f",
      duration: 1,
      error: {
        message: 'Variable "{x}" has not been captured by an earlier step',
        step: 0,
        action: { request: { get: "/a/{x}" } },
      },
    });
    expect(text).toContain("Step 0: GET /a/{x}");
    expect(text).not.toContain("Request:");
    expect(text).not.toContain("Response:");
  });

  it("formats a wait step", () => {
    const text = formatResult({
      success: false,
      flowName: "f",
      duration: 1,
      error: { message: "boom", step: 2, action: { wait: 250 } },
    });
    expect(text).toContain("Step 2: wait 250ms");
  });
});
