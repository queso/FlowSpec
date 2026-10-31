/**
 * The api execution core: runs a `surface: api` flow's steps one at a time,
 * in order.
 *
 * For each request step:
 *   1. Resolve every template the step uses (request fields and assertion
 *      values). A missing capture fails the step before anything is sent.
 *   2. Send the request and check all of the step's assertions (its own
 *      `expect`, plus the flow-level `expect` on the last step) against the
 *      response.
 *   3. GET and HEAD only: while any assertion fails, re-send and re-check
 *      until all pass or the retry budget expires. Every other method is
 *      sent exactly once.
 *   4. Read `capture` values from the response that passed.
 *
 * Every FlowResult this returns has passed through the run's Redactor, so
 * env values and secret captures never reach the caller.
 */

import {
  type ApiResponseSnapshot,
  bodyExcerpt,
  evaluateApiAssertion,
  type ParsedBody,
  parseBody,
} from "./api-assertions.js";
import {
  collectEnvReferences,
  formatUnsetEnv,
  resolveJsonTemplates,
  resolveStringTemplate,
  type TemplateContext,
  unsetEnvReferences,
} from "./api-template.js";
import { DEFAULT_STEP_TIMEOUT } from "./config.js";
import { pollUntilPass } from "./file-matchers.js";
import { resolvePath } from "./matchers.js";
import { Redactor } from "./redact.js";
import { DEFAULT_TIMEOUT } from "./runner.js";
import {
  type ApiAssertion,
  type ApiFlowSpec,
  type ApiRequest,
  type ApiRequestRecord,
  type ApiRequestStep,
  type ApiResponseRecord,
  type FlowError,
  type FlowResult,
  isApiRequestStep,
  RETRYABLE_API_METHODS,
  requestMethod,
} from "./types.js";

export interface ApiRunOptions {
  /** Relative request paths resolve against this. */
  baseUrl?: string;
  /** Retry budget for GET/HEAD steps without their own `timeout`, in ms. */
  timeout?: number;
  /** Deadline for a single request to answer, in ms. */
  requestTimeout?: number;
  /** Config-level headers, applied under `headersScope`. */
  headers?: Record<string, string>;
  headersScope?: "origin" | "all";
  /**
   * The run's redactor. `flowspec run` passes one shared by every flow, so
   * a secret read by one flow is redacted from all later output. Absent, a
   * redactor for this flow alone is created.
   */
  redactor?: Redactor;
  /** Where `{env.NAME}` reads from. Defaults to process.env. */
  env?: Readonly<Record<string, string | undefined>>;
}

const DEFAULT_BASE_URL = "http://localhost:3000";

/**
 * Recorded in place of a config-level header's value. Config headers often
 * carry deployment tokens that are not `{env.NAME}` reads and so are not
 * registered as secrets; recording only the name keeps them out of output.
 */
const CONFIG_HEADER_PLACEHOLDER = "[config header]";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface PreparedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body?: string;
  record: ApiRequestRecord;
}

function scalarTemplate(
  value: string | number | boolean,
  ctx: TemplateContext,
): string {
  return typeof value === "string"
    ? resolveStringTemplate(value, ctx)
    : String(value);
}

/**
 * Build the request a step sends. Throws TemplateError for an unresolvable
 * template and Error for an unusable URL or header.
 */
function prepareRequest(
  request: ApiRequest,
  ctx: TemplateContext,
  options: ApiRunOptions,
): PreparedRequest {
  const method = requestMethod(request);
  const target = method ? request[method] : undefined;
  if (!method || target === undefined) {
    throw new Error("request has no method key");
  }

  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const resolvedTarget = resolveStringTemplate(target, ctx);
  let url: URL;
  try {
    url = new URL(resolvedTarget, baseUrl);
  } catch {
    throw new Error(
      `Invalid request URL "${resolvedTarget}" (base URL ${baseUrl})`,
    );
  }

  for (const [name, value] of Object.entries(request.query ?? {})) {
    url.searchParams.append(name, scalarTemplate(value, ctx));
  }

  const headers = new Headers();
  const configHeaderNames = new Set<string>();
  const configHeaders = options.headers ?? {};
  const sendConfigHeaders =
    (options.headersScope ?? "origin") === "all" ||
    url.origin === new URL(baseUrl).origin;
  if (sendConfigHeaders) {
    for (const [name, value] of Object.entries(configHeaders)) {
      headers.set(name, value);
      configHeaderNames.add(name.toLowerCase());
    }
  }

  // A step's own header replaces a config header of the same name; Headers
  // compares names case-insensitively.
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    headers.set(name, scalarTemplate(value, ctx));
    configHeaderNames.delete(name.toLowerCase());
  }

  let body: string | undefined;
  if (Object.hasOwn(request, "json")) {
    body = JSON.stringify(resolveJsonTemplates(request.json, ctx));
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
  } else if (request.body !== undefined) {
    body = resolveStringTemplate(request.body, ctx);
  }

  const recordedHeaders = Object.fromEntries(
    [...headers.entries()].map(([name, value]) => [
      name,
      configHeaderNames.has(name) ? CONFIG_HEADER_PLACEHOLDER : value,
    ]),
  );

  return {
    method: method.toUpperCase(),
    url,
    headers,
    body,
    record: {
      method: method.toUpperCase(),
      url: url.toString(),
      headers: recordedHeaders,
      ...(body !== undefined ? { body: bodyExcerpt(body) } : {}),
    },
  };
}

/** Resolve the templated values inside one assertion. */
function resolveAssertion(
  assertion: ApiAssertion,
  ctx: TemplateContext,
): ApiAssertion {
  if ("json" in assertion) {
    const json = { ...assertion.json };
    if (Object.hasOwn(json, "equals")) {
      json.equals = resolveJsonTemplates(json.equals, ctx);
    }
    if (json.in !== undefined) {
      json.in = json.in.map((value) => resolveJsonTemplates(value, ctx));
    }
    return { json };
  }
  if ("header" in assertion) {
    const header = { ...assertion.header };
    if (header.equals !== undefined) {
      header.equals = resolveStringTemplate(header.equals, ctx);
    }
    if (header.contains !== undefined) {
      header.contains = resolveStringTemplate(header.contains, ctx);
    }
    return { header };
  }
  return assertion;
}

type SendOutcome =
  | { ok: true; response: ApiResponseSnapshot }
  | { ok: false; message: string };

async function send(
  prepared: PreparedRequest,
  requestTimeout: number,
): Promise<SendOutcome> {
  const started = performance.now();
  try {
    const response = await fetch(prepared.url, {
      method: prepared.method,
      headers: prepared.headers,
      body: prepared.body,
      // An api spec asserts on what the server answered, so a redirect is
      // reported as the 3xx it is rather than followed.
      redirect: "manual",
      signal: AbortSignal.timeout(requestTimeout),
    });
    const body = prepared.method === "HEAD" ? "" : await response.text();
    return {
      ok: true,
      response: {
        status: response.status,
        headers: response.headers,
        body,
        latencyMs: Math.round(performance.now() - started),
      },
    };
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? `no response within ${requestTimeout}ms`
        : errorMessage(error);
    return {
      ok: false,
      message: `Request failed: ${prepared.method} ${prepared.url}: ${reason}`,
    };
  }
}

function responseRecord(response: ApiResponseSnapshot): ApiResponseRecord {
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: bodyExcerpt(response.body),
    latencyMs: response.latencyMs,
  };
}

interface Attempt {
  failure?: string;
  response?: ApiResponseSnapshot;
  parsed?: ParsedBody;
}

type StepOutcome =
  | { ok: true }
  | {
      ok: false;
      message: string;
      request?: ApiRequestRecord;
      response?: ApiResponseRecord;
    };

async function runRequestStep(
  step: ApiRequestStep,
  assertions: ApiAssertion[],
  ctx: TemplateContext & { captures: Map<string, unknown> },
  options: ApiRunOptions,
  redactor: Redactor,
): Promise<StepOutcome> {
  let prepared: PreparedRequest;
  let resolvedAssertions: ApiAssertion[];
  try {
    prepared = prepareRequest(step.request, ctx, options);
    resolvedAssertions = assertions.map((assertion) =>
      resolveAssertion(assertion, ctx),
    );
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }

  const method = requestMethod(step.request);
  const retryable =
    method !== undefined && RETRYABLE_API_METHODS.includes(method);
  const budget = retryable
    ? (step.timeout ?? options.timeout ?? DEFAULT_TIMEOUT)
    : 0;
  const requestTimeout = options.requestTimeout ?? DEFAULT_STEP_TIMEOUT;

  let attempts = 0;
  let last: Attempt = {};
  const started = Date.now();

  const check = async (): Promise<string | undefined> => {
    attempts += 1;
    const sent = await send(prepared, requestTimeout);
    if (!sent.ok) {
      last = { failure: sent.message };
      return sent.message;
    }
    const parsed = parseBody(sent.response.body);
    for (const assertion of resolvedAssertions) {
      const failure = evaluateApiAssertion(assertion, sent.response, parsed);
      if (failure) {
        last = { failure, response: sent.response, parsed };
        return failure;
      }
    }
    last = { response: sent.response, parsed };
    return undefined;
  };

  const failure = await pollUntilPass(check, budget);

  if (failure) {
    const retried =
      attempts > 1
        ? ` (after ${attempts} requests over ${Date.now() - started}ms)`
        : "";
    return {
      ok: false,
      message: `${failure}${retried}`,
      request: prepared.record,
      response: last.response ? responseRecord(last.response) : undefined,
    };
  }

  // Captures read from the response that passed.
  for (const [name, spec] of Object.entries(step.capture ?? {})) {
    const path = typeof spec === "string" ? spec : spec.path;
    const parsed = last.parsed;
    const fail = (reason: string): StepOutcome => ({
      ok: false,
      message: `Capture "${name}" failed: ${reason}`,
      request: prepared.record,
      response: last.response ? responseRecord(last.response) : undefined,
    });

    if (!parsed?.ok) {
      return fail(
        `path "${path}" cannot be read because the response body is not valid JSON. First 500 bytes: ${bodyExcerpt(last.response?.body ?? "")}`,
      );
    }
    const resolved = resolvePath(parsed.value, path);
    if (!resolved.found) {
      return fail(`path "${path}" was not found in the response body`);
    }
    ctx.captures.set(name, resolved.value);
    if (typeof spec !== "string" && spec.secret) {
      redactor.addCaptureSecret(name, resolved.value);
    }
  }

  return { ok: true };
}

/**
 * Run a `surface: api` flow. Never throws for a step or assertion failure;
 * those come back as an unsuccessful FlowResult.
 */
export async function runApiFlow(
  flow: ApiFlowSpec,
  options: ApiRunOptions = {},
): Promise<FlowResult> {
  const startTime = Date.now();
  const env = options.env ?? process.env;
  const redactor = options.redactor ?? new Redactor();

  const finish = (error?: FlowError): FlowResult =>
    redactor.redactDeep({
      success: error === undefined,
      flowName: flow.name,
      duration: Date.now() - startTime,
      ...(error ? { error } : {}),
    });

  // Every env reference is checked before the first request, so a missing
  // key fails the flow before it sends anything. `flowspec run` has already
  // done this for every flow at load time; this covers direct callers.
  const unset = unsetEnvReferences(flow, env);
  if (unset.length > 0) {
    return finish({ message: formatUnsetEnv(unset) });
  }
  for (const reference of collectEnvReferences(flow)) {
    redactor.addEnvSecret(reference.name, env[reference.name]);
  }

  const ctx = { captures: new Map<string, unknown>(), env };
  const lastIndex = flow.steps.length - 1;

  for (const [index, step] of flow.steps.entries()) {
    if (!isApiRequestStep(step)) {
      if (index === lastIndex && (flow.expect ?? []).length > 0) {
        return finish({
          message:
            "a flow-level expect applies to the last step, which must be a request",
          step: index,
          action: step,
        });
      }
      await sleep(step.wait);
      continue;
    }

    const assertions = [
      ...(step.expect ?? []),
      ...(index === lastIndex ? (flow.expect ?? []) : []),
    ];

    const outcome = await runRequestStep(
      step,
      assertions,
      ctx,
      options,
      redactor,
    );
    if (!outcome.ok) {
      return finish({
        message: outcome.message,
        step: index,
        action: step,
        ...(outcome.request ? { request: outcome.request } : {}),
        ...(outcome.response ? { response: outcome.response } : {}),
      });
    }
  }

  return finish();
}
