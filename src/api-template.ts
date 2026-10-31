/**
 * Flow variable templates for the api surface.
 *
 * - `{name}` reads a captured variable; `{env.NAME}` reads process.env.
 * - `{{` is a literal `{` and `}}` is a literal `}`.
 * - Any other braced text is literal, so `{"a": 1}` in a body is untouched.
 *
 * A string that is exactly one reference resolves to the variable's value
 * with its type kept. A reference inside a longer string is converted to a
 * string, and embedding an object, array or null is an error.
 *
 * Flow templates are separate from the `${VAR}` interpolation in
 * src/config.ts: that runs once when the config loads, while these resolve
 * as each step runs and can read captures.
 */

import {
  type ApiAssertion,
  type ApiFlowSpec,
  isApiRequestStep,
  VARIABLE_NAME_PATTERN,
} from "./types.js";

/** Raised when a template cannot be resolved; the message names the variable. */
export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

export interface TemplateContext {
  /** Values captured by earlier steps of the flow. */
  captures: ReadonlyMap<string, unknown>;
  /** Where `{env.NAME}` reads from; process.env in production. */
  env: Readonly<Record<string, string | undefined>>;
}

type Segment =
  | { kind: "text"; text: string }
  | { kind: "capture"; name: string }
  | { kind: "env"; name: string };

const REFERENCE_REGEX = new RegExp(
  `\\{(env\\.)?(${VARIABLE_NAME_PATTERN})\\}`,
  "y",
);

/** Split a template into literal text and references, applying escapes. */
function parseTemplate(template: string): Segment[] {
  const segments: Segment[] = [];
  let text = "";
  let index = 0;

  const flushText = () => {
    if (text.length > 0) {
      segments.push({ kind: "text", text });
      text = "";
    }
  };

  while (index < template.length) {
    const char = template[index];
    const next = template[index + 1];

    if ((char === "{" || char === "}") && next === char) {
      text += char;
      index += 2;
      continue;
    }

    if (char === "{") {
      REFERENCE_REGEX.lastIndex = index;
      const match = REFERENCE_REGEX.exec(template);
      if (match) {
        flushText();
        segments.push(
          match[1]
            ? { kind: "env", name: match[2] }
            : { kind: "capture", name: match[2] },
        );
        index += match[0].length;
        continue;
      }
    }

    text += char;
    index += 1;
  }

  flushText();
  return segments;
}

function referenceLabel(segment: Exclude<Segment, { kind: "text" }>): string {
  return segment.kind === "env" ? `{env.${segment.name}}` : `{${segment.name}}`;
}

function readReference(
  segment: Exclude<Segment, { kind: "text" }>,
  ctx: TemplateContext,
): unknown {
  if (segment.kind === "env") {
    const value = Object.hasOwn(ctx.env, segment.name)
      ? ctx.env[segment.name]
      : undefined;
    if (value === undefined) {
      throw new TemplateError(
        `Environment variable "${segment.name}" is not set (referenced as {env.${segment.name}})`,
      );
    }
    return value;
  }

  if (!ctx.captures.has(segment.name)) {
    throw new TemplateError(
      `Variable "{${segment.name}}" has not been captured by an earlier step`,
    );
  }
  return ctx.captures.get(segment.name);
}

function describeKind(value: unknown): string | undefined {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return undefined;
}

/**
 * Resolve one template string. Returns the variable's own value for a
 * whole-string reference, and a string otherwise. Throws TemplateError.
 */
export function resolveTemplate(
  template: string,
  ctx: TemplateContext,
): unknown {
  const segments = parseTemplate(template);

  if (segments.length === 1 && segments[0].kind !== "text") {
    return readReference(segments[0], ctx);
  }

  return segments
    .map((segment) => {
      if (segment.kind === "text") {
        return segment.text;
      }
      const value = readReference(segment, ctx);
      const kind = describeKind(value);
      if (kind) {
        throw new TemplateError(
          `Variable "${referenceLabel(segment)}" holds ${kind} and cannot be embedded in the string "${template}"`,
        );
      }
      return String(value);
    })
    .join("");
}

/** Resolve a template that must produce a string (paths, header values). */
export function resolveStringTemplate(
  template: string,
  ctx: TemplateContext,
): string {
  const value = resolveTemplate(template, ctx);
  const kind = describeKind(value);
  if (kind) {
    throw new TemplateError(
      `"${template}" resolves to ${kind}, but this field needs a string`,
    );
  }
  return String(value);
}

/**
 * Resolve every string value inside a JSON-shaped value. Object keys are
 * not templated.
 */
export function resolveJsonTemplates(
  value: unknown,
  ctx: TemplateContext,
): unknown {
  if (typeof value === "string") {
    return resolveTemplate(value, ctx);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveJsonTemplates(item, ctx));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveJsonTemplates(item, ctx),
      ]),
    );
  }
  return value;
}

export interface EnvReference {
  name: string;
  /** Dot path to the field holding the reference, e.g. "steps.0.request.headers.Authorization". */
  location: string;
}

/** Every string inside `value` that templates apply to, with its location. */
function* templatedStrings(
  value: unknown,
  location: string,
): Generator<[string, string]> {
  if (typeof value === "string") {
    yield [value, location];
  } else if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      yield* templatedStrings(item, `${location}.${index}`);
    }
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      yield* templatedStrings(item, `${location}.${key}`);
    }
  }
}

/**
 * The templated values of an assertion: json.equals, json.in members, and
 * header.equals/contains. Not json.matches, JSONPaths or header names.
 */
function* assertionTemplates(
  assertion: ApiAssertion,
  location: string,
): Generator<[string, string]> {
  if ("json" in assertion) {
    if (Object.hasOwn(assertion.json, "equals")) {
      yield* templatedStrings(assertion.json.equals, `${location}.json.equals`);
    }
    if (assertion.json.in) {
      yield* templatedStrings(assertion.json.in, `${location}.json.in`);
    }
  } else if ("header" in assertion) {
    yield* templatedStrings(
      assertion.header.equals,
      `${location}.header.equals`,
    );
    yield* templatedStrings(
      assertion.header.contains,
      `${location}.header.contains`,
    );
  }
}

/** Every templated string in an api flow, with its location. */
function* flowTemplates(flow: ApiFlowSpec): Generator<[string, string]> {
  for (const [index, step] of flow.steps.entries()) {
    if (!isApiRequestStep(step)) {
      continue;
    }
    const base = `steps.${index}`;
    const { request } = step;
    for (const [key, value] of Object.entries(request)) {
      if (key === "headers" || key === "query" || key === "json") {
        yield* templatedStrings(value, `${base}.request.${key}`);
      } else if (typeof value === "string") {
        // A method key (the path or URL) or `body`.
        yield [value, `${base}.request.${key}`];
      }
    }
    for (const [assertionIndex, assertion] of (step.expect ?? []).entries()) {
      yield* assertionTemplates(assertion, `${base}.expect.${assertionIndex}`);
    }
  }
  for (const [index, assertion] of (flow.expect ?? []).entries()) {
    yield* assertionTemplates(assertion, `expect.${index}`);
  }
}

/**
 * Every `{env.NAME}` reference in the flow's templated fields, in document
 * order. Used to fail a run before any request is sent when one is unset,
 * and to register env values for redaction.
 */
export function collectEnvReferences(flow: ApiFlowSpec): EnvReference[] {
  const references: EnvReference[] = [];
  for (const [template, location] of flowTemplates(flow)) {
    for (const segment of parseTemplate(template)) {
      if (segment.kind === "env") {
        references.push({ name: segment.name, location });
      }
    }
  }
  return references;
}
