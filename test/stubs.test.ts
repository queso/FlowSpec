/**
 * Tests for source module stubs
 *
 * These tests verify that the stub modules exist, export the correct functions,
 * and throw "Not implemented" errors.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = join(__dirname, "..", "src");

describe("Source Module Stubs", () => {
  it("should have all required stub files", () => {
    expect(existsSync(join(SRC_DIR, "parser.ts"))).toBe(true);
    expect(existsSync(join(SRC_DIR, "runner.ts"))).toBe(true);
    expect(existsSync(join(SRC_DIR, "reporter.ts"))).toBe(true);
    expect(existsSync(join(SRC_DIR, "index.ts"))).toBe(true);
  });

  it("parser should export parseFlow function that throws", async () => {
    const { parseFlow } = await import("../src/parser");
    expect(typeof parseFlow).toBe("function");
    expect(() => parseFlow("test: yaml")).toThrow("Not implemented");
  });

  it("runner should export runFlow function that throws", async () => {
    const { runFlow } = await import("../src/runner");
    expect(typeof runFlow).toBe("function");

    const mockFlowSpec = {
      name: "test",
      description: "test flow",
      steps: [{ visit: "/test" }],
      expect: [{ visible: "Test" }],
    };
    await expect(runFlow(mockFlowSpec)).rejects.toThrow("Not implemented");
  });

  it("reporter should export formatError function that throws", async () => {
    const { formatError } = await import("../src/reporter");
    expect(typeof formatError).toBe("function");
    expect(() => formatError({ message: "Test error" })).toThrow(
      "Not implemented",
    );
  });
});
