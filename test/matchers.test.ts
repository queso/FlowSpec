import { describe, expect, it } from "vitest";
import {
  EXCERPT_LIMIT,
  matchContains,
  matchJsonPath,
  matchRegex,
} from "../src/matchers";

/**
 * Tests for WI-802: surface-agnostic contains, regex, and dot-path JSON
 * matchers. Pure functions, no surface-specific types — the Conduit (#7)
 * and API (#8) surfaces reuse these unchanged (per PRD-0007 design intent).
 *
 * Contract pinned by the work item:
 *  - matchContains(haystack, needle): MatchFailure | undefined
 *  - matchRegex(haystack, pattern): MatchFailure | undefined
 *  - matchJsonPath(text, path, expected): MatchFailure | undefined
 *  - undefined means pass; a truthy structured failure means fail. None of
 *    the three ever throws, even on malformed regex or invalid JSON.
 *  - Every failure's `.message` is a human-readable string that NAMES the
 *    specific detail the AC calls out: the needle, the pattern, the full
 *    dot-path, or the JSON parse error — plus, where the source text can be
 *    long, a head-truncated excerpt bounded by EXCERPT_LIMIT characters
 *    with an explicit "[truncated]" marker appended only when truncation
 *    actually occurred.
 *  - Dot-path JSON comparison uses deep value equality (objects/arrays),
 *    not reference or primitive-only equality.
 */

describe("matchContains", () => {
  it("passes (returns undefined) when the needle is a substring of the haystack", () => {
    expect(matchContains("hello world", "world")).toBeUndefined();
  });

  it("passes when the needle equals the entire haystack", () => {
    expect(matchContains("exact", "exact")).toBeUndefined();
  });

  it("returns a structured failure naming the expected text when the needle is absent", () => {
    const failure = matchContains("hello world", "xyz");
    expect(failure).toBeDefined();
    expect(failure?.message).toContain("xyz");
  });

  it("carries a bounded excerpt of the actual haystack text in the failure", () => {
    const failure = matchContains("hello world", "xyz");
    expect(failure?.message).toContain("hello world");
  });
});

describe("matchRegex", () => {
  it("passes (returns undefined) when the pattern matches the haystack", () => {
    expect(matchRegex("order #12345", "#\\d+")).toBeUndefined();
  });

  it("passes for an anchored pattern matching the full haystack", () => {
    expect(matchRegex("555-1234", "^\\d{3}-\\d{4}$")).toBeUndefined();
  });

  it("returns a structured failure naming the pattern when it does not match", () => {
    const failure = matchRegex("abc", "^\\d{3}-\\d{4}$");
    expect(failure).toBeDefined();
    expect(failure?.message).toContain("^\\d{3}-\\d{4}$");
  });

  it("carries a bounded excerpt of the actual haystack text in the failure", () => {
    const failure = matchRegex("abc", "^\\d{3}-\\d{4}$");
    expect(failure?.message).toContain("abc");
  });

  it("returns a structured failure (does not throw) for an invalid regex pattern", () => {
    const failure = matchRegex("some text", "(unclosed");
    expect(failure).toBeDefined();
  });
});

describe("matchJsonPath: value equality", () => {
  const nested = JSON.stringify({ a: { b: 2 } });

  it("passes when the dot-path value equals the expected primitive", () => {
    expect(matchJsonPath(nested, "$.a.b", 2)).toBeUndefined();
  });

  it("fails when the dot-path value does not equal the expected primitive, naming both values", () => {
    const failure = matchJsonPath(nested, "$.a.b", 3);
    expect(failure).toBeDefined();
    expect(failure?.message).toContain("3");
    expect(failure?.message).toContain("2");
  });

  it("resolves a single-segment path against a top-level key", () => {
    const text = JSON.stringify({ status: "ok" });
    expect(matchJsonPath(text, "$.status", "ok")).toBeUndefined();
  });

  it("uses deep value equality for an object 'equals' value, not reference or shallow equality", () => {
    const text = JSON.stringify({ a: { b: { x: 1, y: [1, 2, 3] } } });
    const failure = matchJsonPath(text, "$.a.b", { x: 1, y: [1, 2, 3] });
    expect(failure).toBeUndefined();
  });

  it("fails deep equality when a nested array element differs", () => {
    const text = JSON.stringify({ a: { b: { x: 1, y: [1, 2, 3] } } });
    const failure = matchJsonPath(text, "$.a.b", { x: 1, y: [1, 2, 4] });
    expect(failure).toBeDefined();
  });

  it("uses deep value equality for an array 'equals' value", () => {
    const text = JSON.stringify({ items: [1, 2, 3] });
    expect(matchJsonPath(text, "$.items", [1, 2, 3])).toBeUndefined();
    const failure = matchJsonPath(text, "$.items", [1, 2, 3, 4]);
    expect(failure).toBeDefined();
  });
});

describe("matchJsonPath: absent path", () => {
  it("returns a structured failure naming the full path when a key is absent, without throwing or silently passing", () => {
    const text = JSON.stringify({ a: { b: 2 } });
    const failure = matchJsonPath(text, "$.a.c", 5);
    expect(failure).toBeDefined();
    expect(failure?.message).toContain("$.a.c");
  });

  it("returns a structured failure when the path traverses into a JSON primitive", () => {
    const failure = matchJsonPath("42", "$.a", 1);
    expect(failure).toBeDefined();
  });

  it("returns a structured failure naming the full path for a deeply absent key", () => {
    const failure = matchJsonPath(JSON.stringify({ a: 1 }), "$.a.b.c", 1);
    expect(failure).toBeDefined();
    expect(failure?.message).toContain("$.a.b.c");
  });
});

describe("matchJsonPath: invalid JSON text", () => {
  it("returns a structured failure carrying the parse message when the text is not valid JSON", () => {
    const failure = matchJsonPath("{not valid json", "$.a", 1);
    expect(failure).toBeDefined();
    expect(failure?.message.length).toBeGreaterThan(0);
  });

  it("carries a bounded head of the invalid text in the failure", () => {
    const failure = matchJsonPath("{not valid json", "$.a", 1);
    expect(failure?.message).toContain("{not valid json");
  });

  it("does not throw for invalid JSON text", () => {
    expect(() => matchJsonPath("{{{ this is not json", "$.a", 1)).not.toThrow();
  });
});

describe("bounded excerpts", () => {
  it("does not truncate or mark an excerpt shorter than EXCERPT_LIMIT", () => {
    const shortHaystack = "a short haystack";
    const failure = matchContains(shortHaystack, "absent-needle");
    expect(failure?.message).toContain(shortHaystack);
    expect(failure?.message).not.toContain("[truncated]");
  });

  it("head-truncates an excerpt longer than EXCERPT_LIMIT and marks it explicitly", () => {
    const head = "A".repeat(EXCERPT_LIMIT);
    const longHaystack = `${head}TAIL_SENTINEL_SHOULD_NOT_APPEAR`;
    const failure = matchContains(longHaystack, "absent-needle");
    expect(failure).toBeDefined();
    expect(failure?.message).toContain(head);
    expect(failure?.message).not.toContain("TAIL_SENTINEL_SHOULD_NOT_APPEAR");
    expect(failure?.message).toContain("[truncated]");
  });

  it("head-truncates a long invalid-JSON excerpt the same way", () => {
    const head = "{".repeat(EXCERPT_LIMIT);
    const longInvalidJson = `${head}TAIL_SENTINEL_SHOULD_NOT_APPEAR`;
    const failure = matchJsonPath(longInvalidJson, "$.a", 1);
    expect(failure).toBeDefined();
    expect(failure?.message).not.toContain("TAIL_SENTINEL_SHOULD_NOT_APPEAR");
    expect(failure?.message).toContain("[truncated]");
  });
});

describe("EXCERPT_LIMIT constant", () => {
  it("is exported as a positive number shared by both text- and JSON-excerpt bounding", () => {
    expect(typeof EXCERPT_LIMIT).toBe("number");
    expect(EXCERPT_LIMIT).toBeGreaterThan(0);
  });
});

describe("matchers never throw, even on malformed input", () => {
  it.each([
    ["invalid JSON text", () => matchJsonPath("{not valid json", "$.a", 1)],
    [
      "JSON root is a primitive but the path expects to traverse into it",
      () => matchJsonPath("42", "$.a", 1),
    ],
    [
      "path references a deeply absent key",
      () => matchJsonPath(JSON.stringify({ a: 1 }), "$.a.b.c", 1),
    ],
    ["invalid regex pattern", () => matchRegex("some text", "(unclosed")],
  ])("%s does not throw", (_label, thunk) => {
    expect(thunk).not.toThrow();
  });
});
