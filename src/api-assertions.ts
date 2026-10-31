/**
 * Evaluates api-surface assertions (status, json, header, latency_under)
 * against one HTTP response. Assertion values arrive with their templates
 * already resolved (src/api-runner.ts does that before the request is sent).
 *
 * Comparison for json `equals` and `in` is src/matchers.ts's deepEqual, the
 * same strict equality the CLI surface's json_output uses: "1.25" never
 * equals 1.25. Paths resolve with the same dot-path resolver.
 */

import { boundedExcerpt, deepEqual, resolvePath } from "./matchers.js";
import type { ApiAssertion } from "./types.js";

/** How much of a response body a failure quotes back. */
export const BODY_EXCERPT_BYTES = 500;

const TRUNCATION_MARKER = "[truncated]";

/** The first BODY_EXCERPT_BYTES bytes of `text`, marked when cut. */
export function bodyExcerpt(text: string): string {
  const bytes = Buffer.from(text, "utf-8");
  if (bytes.length <= BODY_EXCERPT_BYTES) {
    return text;
  }
  return `${bytes.subarray(0, BODY_EXCERPT_BYTES).toString("utf-8")}${TRUNCATION_MARKER}`;
}

export interface ApiResponseSnapshot {
  status: number;
  headers: Headers;
  body: string;
  /** Milliseconds from sending the request to having read the whole body. */
  latencyMs: number;
}

export type ParsedBody =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

/** Parse a response body as JSON without throwing. */
export function parseBody(body: string): ParsedBody {
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** "a number", "an object", "null". */
function describeType(value: unknown): string {
  const name = typeName(value);
  if (name === "null") return name;
  return /^[aeiou]/.test(name) ? `an ${name}` : `a ${name}`;
}

/** JSON rendering, so a string's quotes show and "1" reads differently from 1. */
function show(value: unknown): string {
  return boundedExcerpt(JSON.stringify(value) ?? String(value));
}

function notJsonMessage(path: string, body: string, reason: string): string {
  return `json ${path}: response body is not valid JSON (${reason}). First ${BODY_EXCERPT_BYTES} bytes: ${bodyExcerpt(body)}`;
}

function evaluateJson(
  json: Extract<ApiAssertion, { json: unknown }>["json"],
  response: ApiResponseSnapshot,
  parsed: ParsedBody,
): string | undefined {
  const path = json.path ?? "$";

  if (!parsed.ok) {
    return notJsonMessage(path, response.body, parsed.reason);
  }

  const resolved = resolvePath(parsed.value, path);

  if (json.exists !== undefined) {
    if (json.exists && !resolved.found) {
      return `json ${path} does not exist`;
    }
    if (!json.exists && resolved.found) {
      return `json ${path} exists: got ${show(resolved.value)}`;
    }
    return undefined;
  }

  if (!resolved.found) {
    return `json ${path} was not found in the response body`;
  }
  const actual = resolved.value;

  if (Object.hasOwn(json, "equals")) {
    if (deepEqual(actual, json.equals)) {
      return undefined;
    }
    const expectedType = typeName(json.equals);
    const actualType = typeName(actual);
    return expectedType === actualType
      ? `json ${path} expected ${show(json.equals)} but got ${show(actual)}`
      : `json ${path} expected ${show(json.equals)} (${expectedType}) but got ${show(actual)} (${actualType})`;
  }

  if (json.in !== undefined) {
    if (json.in.some((candidate) => deepEqual(actual, candidate))) {
      return undefined;
    }
    return `json ${path} expected one of ${show(json.in)} but got ${show(actual)}`;
  }

  if (json.matches !== undefined) {
    if (typeof actual !== "string") {
      return `json ${path} is ${describeType(actual)}, but matches needs a string: got ${show(actual)}`;
    }
    if (new RegExp(json.matches).test(actual)) {
      return undefined;
    }
    return `json ${path} did not match pattern "${json.matches}": got ${show(actual)}`;
  }

  return `json ${path} has no comparison (equals, in, matches or exists)`;
}

function evaluateHeader(
  header: Extract<ApiAssertion, { header: unknown }>["header"],
  response: ApiResponseSnapshot,
): string | undefined {
  const actual = response.headers.get(header.name);
  if (actual === null) {
    return `Response header "${header.name}" is missing`;
  }
  if (header.equals !== undefined && actual !== header.equals) {
    return `Response header "${header.name}" expected "${header.equals}" but got "${actual}"`;
  }
  if (header.contains !== undefined && !actual.includes(header.contains)) {
    return `Response header "${header.name}" expected to contain "${header.contains}" but got "${actual}"`;
  }
  return undefined;
}

/**
 * Check one assertion against `response`. Returns a failure message, or
 * undefined when it passes. `parsed` is the body parsed once per response.
 */
export function evaluateApiAssertion(
  assertion: ApiAssertion,
  response: ApiResponseSnapshot,
  parsed: ParsedBody,
): string | undefined {
  if ("status" in assertion) {
    return response.status === assertion.status
      ? undefined
      : `Expected status ${assertion.status} but got ${response.status}. Body: ${bodyExcerpt(response.body)}`;
  }
  if ("json" in assertion) {
    return evaluateJson(assertion.json, response, parsed);
  }
  if ("header" in assertion) {
    return evaluateHeader(assertion.header, response);
  }
  if ("latency_under" in assertion) {
    return response.latencyMs < assertion.latency_under
      ? undefined
      : `Response took ${response.latencyMs}ms, expected under ${assertion.latency_under}ms`;
  }
  return "Unrecognized api assertion shape";
}
