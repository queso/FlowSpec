import { describe, expect, it } from "vitest";
import {
  collectEnvReferences,
  resolveJsonTemplates,
  resolveTemplate,
  type TemplateContext,
  TemplateError,
} from "../src/api-template";
import { parseFlowSpec } from "../src/parser";
import { asApiFlow } from "../src/types";

function context(
  captures: Record<string, unknown> = {},
  env: Record<string, string> = {},
): TemplateContext {
  return { captures: new Map(Object.entries(captures)), env };
}

function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TemplateError);
    return (error as Error).message;
  }
  throw new Error("expected a TemplateError");
}

describe("resolveTemplate", () => {
  it("keeps the captured value's type for a whole-string reference", () => {
    const ctx = context({
      count: 3,
      price: 1.25,
      ok: false,
      ids: ["a"],
      obj: { a: 1 },
      none: null,
    });
    expect(resolveTemplate("{count}", ctx)).toBe(3);
    expect(resolveTemplate("{price}", ctx)).toBe(1.25);
    expect(resolveTemplate("{ok}", ctx)).toBe(false);
    expect(resolveTemplate("{ids}", ctx)).toEqual(["a"]);
    expect(resolveTemplate("{obj}", ctx)).toEqual({ a: 1 });
    expect(resolveTemplate("{none}", ctx)).toBeNull();
  });

  it("converts an embedded reference to a string", () => {
    const ctx = context({ id: 42, flag: true, name: "pkg" });
    expect(resolveTemplate("/orders/{id}", ctx)).toBe("/orders/42");
    expect(resolveTemplate("{flag}-{name}", ctx)).toBe("true-pkg");
  });

  it("rejects embedding an object, array, or null value, naming the variable", () => {
    const ctx = context({ obj: { a: 1 }, list: [1], none: null });
    expect(thrownMessage(() => resolveTemplate("x {obj}", ctx))).toContain(
      '"{obj}" holds an object',
    );
    expect(thrownMessage(() => resolveTemplate("{list}/x", ctx))).toContain(
      '"{list}" holds an array',
    );
    expect(thrownMessage(() => resolveTemplate("a{none}", ctx))).toContain(
      '"{none}" holds null',
    );
  });

  it("reads env values as strings, whole or embedded", () => {
    const ctx = context({}, { KEY: "abc123", PORT: "8080" });
    expect(resolveTemplate("{env.PORT}", ctx)).toBe("8080");
    expect(resolveTemplate("Bearer {env.KEY}", ctx)).toBe("Bearer abc123");
  });

  it("fails on an unset env variable, naming it", () => {
    expect(
      thrownMessage(() => resolveTemplate("{env.MISSING}", context())),
    ).toContain('Environment variable "MISSING" is not set');
  });

  it("fails on a capture that does not exist yet, naming it", () => {
    expect(
      thrownMessage(() => resolveTemplate("/labels/{package_id}", context())),
    ).toContain('Variable "{package_id}" has not been captured');
  });

  it("honors {{ and }} escapes", () => {
    const ctx = context({ name: "v" });
    expect(resolveTemplate("{{name}}", ctx)).toBe("{name}");
    expect(resolveTemplate("{{{name}}}", ctx)).toBe("{v}");
    expect(resolveTemplate("a {{ b", ctx)).toBe("a { b");
    expect(resolveTemplate("a }} b", ctx)).toBe("a } b");
  });

  it("leaves any other braced text alone", () => {
    const ctx = context();
    expect(resolveTemplate('{"a": 1}', ctx)).toBe('{"a": 1}');
    expect(resolveTemplate("{ name }", ctx)).toBe("{ name }");
    expect(resolveTemplate("{1abc}", ctx)).toBe("{1abc}");
    expect(resolveTemplate("{env.}", ctx)).toBe("{env.}");
    expect(resolveTemplate("{a-b}", ctx)).toBe("{a-b}");
    expect(resolveTemplate("open { only", ctx)).toBe("open { only");
  });

  it("returns a string with no references unchanged", () => {
    expect(resolveTemplate("/plain/path", context())).toBe("/plain/path");
  });
});

describe("resolveJsonTemplates", () => {
  it("templates string values recursively, keeping whole-reference types, and leaves keys alone", () => {
    const ctx = context({ id: 576001, unit: "LB" }, { KEY: "k" });
    const resolved = resolveJsonTemplates(
      {
        "{id}": "{id}",
        orderIds: ["{id}", "o-{id}"],
        weight: { value: "1.2", unit: "{unit}" },
        auth: "{env.KEY}",
        n: 5,
        b: null,
      },
      ctx,
    );
    expect(resolved).toEqual({
      "{id}": 576001,
      orderIds: [576001, "o-576001"],
      weight: { value: "1.2", unit: "LB" },
      auth: "k",
      n: 5,
      b: null,
    });
  });
});

describe("collectEnvReferences", () => {
  it("finds env references in every templated field and nowhere else", () => {
    const flow = asApiFlow(
      parseFlowSpec(`
name: env-scan
description: env scan
surface: api
steps:
  - request:
      post: "{env.BASE}/x"
      headers: {Authorization: "Bearer {env.HEADER_KEY}", "{env.HEADER_NAME}": "v"}
      query: {k: "{env.QUERY_KEY}"}
      json: {nested: ["{env.JSON_KEY}"], "{env.JSON_OBJECT_KEY}": 1}
    expect:
      - json: {path: "$.a", equals: "{env.EQUALS_KEY}"}
      - json: {path: "$.b", in: ["x", "{env.IN_KEY}"]}
      - json: {path: "$.c", matches: "{env.MATCHES_KEY}"}
      - header: {name: "x-a", equals: "{env.HEADER_EQUALS}"}
      - header: {name: "x-b", contains: "{env.HEADER_CONTAINS}"}
  - request:
      put: /y
      body: "raw {env.BODY_KEY} {{env.ESCAPED}}"
expect:
  - status: 200
`),
    );
    const names = collectEnvReferences(flow).map((ref) => ref.name);
    expect(names.sort()).toEqual(
      [
        "BASE",
        "BODY_KEY",
        "EQUALS_KEY",
        "HEADER_CONTAINS",
        "HEADER_EQUALS",
        "HEADER_KEY",
        "IN_KEY",
        "JSON_KEY",
        "QUERY_KEY",
      ].sort(),
    );
  });

  it("reports where each reference is", () => {
    const flow = asApiFlow(
      parseFlowSpec(`
name: env-where
description: env where
surface: api
steps:
  - request:
      get: /x
      headers: {Authorization: "Bearer {env.KEY}"}
    expect:
      - status: 200
`),
    );
    expect(collectEnvReferences(flow)).toEqual([
      { name: "KEY", location: "steps.0.request.headers.Authorization" },
    ]);
  });
});
