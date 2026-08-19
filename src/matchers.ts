/**
 * Surface-agnostic assertion primitives: substring containment, regex
 * matching, and dot-path JSON value comparison. Pure functions over plain
 * strings and values — no dependency on any surface's step/assertion types —
 * so the CLI assertion vocabulary and the upcoming Conduit/API surfaces can
 * all reuse them unchanged.
 *
 * None of the three ever throws: malformed regex and invalid JSON are
 * reported as a structured failure, never an exception.
 */

export interface MatchFailure {
  message: string;
  expected?: unknown;
  actual?: unknown;
}

/**
 * Shared bound for how much source text a failure message quotes back.
 * Kept as a single named constant so every matcher — and the CLI-assertion
 * item that reuses it — points at the same number.
 */
export const EXCERPT_LIMIT = 200;

const TRUNCATION_MARKER = "[truncated]";

/**
 * Head-truncate `text` to EXCERPT_LIMIT characters, appending an explicit
 * marker only when truncation actually happened. Text at or under the limit
 * is returned unchanged.
 */
function excerpt(text: string): string {
  if (text.length <= EXCERPT_LIMIT) {
    return text;
  }
  return `${text.slice(0, EXCERPT_LIMIT)}${TRUNCATION_MARKER}`;
}

/** Render a value for inclusion in a failure message. */
function describeValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Passes when `needle` is a substring of `haystack`. On failure, the message
 * names the needle and carries a bounded excerpt of the haystack.
 */
export function matchContains(
  haystack: string,
  needle: string,
): MatchFailure | undefined {
  if (haystack.includes(needle)) {
    return undefined;
  }
  return {
    message: `Expected text to contain "${needle}" but it was not found. Actual: ${excerpt(haystack)}`,
    expected: needle,
    actual: haystack,
  };
}

/**
 * Passes when `pattern` (compiled as a RegExp) matches `haystack`. Never
 * throws: a pattern that fails to compile is reported as a structured
 * failure rather than propagating the SyntaxError. On failure, the message
 * names the pattern and carries a bounded excerpt of the haystack.
 */
export function matchRegex(
  haystack: string,
  pattern: string,
): MatchFailure | undefined {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      message: `Invalid regex pattern "${pattern}": ${reason}. Actual: ${excerpt(haystack)}`,
      expected: pattern,
      actual: haystack,
    };
  }

  if (regex.test(haystack)) {
    return undefined;
  }

  return {
    message: `Expected text to match pattern "${pattern}" but it did not. Actual: ${excerpt(haystack)}`,
    expected: pattern,
    actual: haystack,
  };
}

type PathResolution = { found: true; value: unknown } | { found: false };

/**
 * Resolve a "$.a.b" style dot-path against a parsed JSON value. The leading
 * "$" is stripped before splitting on ".". Traversing into a missing key, or
 * into a non-object/array value, resolves to not-found rather than throwing.
 */
function resolvePath(root: unknown, path: string): PathResolution {
  const withoutRoot = path.startsWith("$") ? path.slice(1) : path;
  const segments = withoutRoot
    .split(".")
    .filter((segment) => segment.length > 0);

  let current = root;
  for (const key of segments) {
    if (current === null || typeof current !== "object") {
      return { found: false };
    }
    const container = current as Record<string, unknown>;
    if (!Object.hasOwn(container, key)) {
      return { found: false };
    }
    current = container[key];
  }

  return { found: true, value: current };
}

/** Structural (deep) equality over JSON-shaped values. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== typeof b) {
    return false;
  }
  if (a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length &&
      a.every((item, index) => deepEqual(item, b[index]))
    );
  }
  if (typeof a === "object" && typeof b === "object") {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every(
        (key) => Object.hasOwn(bObj, key) && deepEqual(aObj[key], bObj[key]),
      )
    );
  }
  return false;
}

/**
 * Parses `text` as JSON, resolves `path` (a "$.a.b" style dot-path) against
 * it, and compares the resolved value to `expected` by deep equality. Never
 * throws: invalid JSON, an absent path segment, and a mismatch are all
 * reported as a structured failure.
 *
 * - Invalid JSON: the message carries the parser's own error plus a bounded
 *   excerpt of the raw text.
 * - Absent path (including traversal into a primitive): the message names
 *   the full original path string.
 * - Value mismatch: the message names both the expected and actual values.
 */
export function matchJsonPath(
  text: string,
  path: string,
  expected: unknown,
): MatchFailure | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      message: `Could not parse JSON: ${reason}. Text: ${excerpt(text)}`,
    };
  }

  const resolved = resolvePath(parsed, path);
  if (!resolved.found) {
    return {
      message: `Path "${path}" was not found in the JSON document`,
      expected: path,
    };
  }

  if (deepEqual(resolved.value, expected)) {
    return undefined;
  }

  return {
    message: `Path "${path}" expected ${describeValue(expected)} but got ${describeValue(resolved.value)}`,
    expected,
    actual: resolved.value,
  };
}
