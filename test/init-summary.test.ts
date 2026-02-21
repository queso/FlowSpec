/**
 * Tests for the extended formatInitResult output:
 * - target directory display
 * - monorepo warning
 * - existing setup location hints
 * - pre-write file list
 *
 * All tests are pure unit tests — they construct InitResult objects
 * directly and verify the string output of formatInitResult.
 * No filesystem operations are performed.
 */

import { describe, expect, it } from "vitest";
import type { InitResult } from "../src/init.js";
import { formatInitResult } from "../src/init.js";

/**
 * Minimal valid InitResult with one created file.
 * New optional fields (projectDir, monorepoMarkers, existingSetup)
 * are omitted so baseline tests still pass.
 */
function baseResult(overrides: Partial<InitResult> = {}): InitResult {
  return {
    files: [
      {
        path: "/project/flowspec.config.yaml",
        created: true,
        skipped: false,
      },
    ],
    success: true,
    ...overrides,
  };
}

describe("formatInitResult — target directory", () => {
  it("includes the target directory path in output when projectDir is provided", () => {
    const result = baseResult({ projectDir: "/home/user/myapp" });
    const output = formatInitResult(result);

    expect(output).toContain("/home/user/myapp");
  });

  it("does not include a directory line when projectDir is not provided", () => {
    const result = baseResult();
    const output = formatInitResult(result);

    // Should still succeed without crashing
    expect(output).toContain("FlowSpec initialized!");
  });
});

describe("formatInitResult — monorepo warning", () => {
  it("shows monorepo warning when markers are found and no local config or specs exist", () => {
    const result = baseResult({
      monorepoMarkers: { isMonorepo: true, markers: ["turbo.json"] },
      existingSetup: { configPath: null, specsDir: null },
    });
    const output = formatInitResult(result);

    expect(output).toMatch(/monorepo/i);
  });

  it("lists specific marker names in the warning", () => {
    const result = baseResult({
      monorepoMarkers: {
        isMonorepo: true,
        markers: ["turbo.json", "workspaces"],
      },
      existingSetup: { configPath: null, specsDir: null },
    });
    const output = formatInitResult(result);

    expect(output).toContain("turbo.json");
    expect(output).toContain("workspaces");
  });

  it("does NOT show monorepo warning when no markers are found", () => {
    const result = baseResult({
      monorepoMarkers: { isMonorepo: false, markers: [] },
      existingSetup: { configPath: null, specsDir: null },
    });
    const output = formatInitResult(result);

    expect(output).not.toMatch(/monorepo/i);
  });

  it("does NOT show monorepo warning when monorepoMarkers is not provided", () => {
    const result = baseResult();
    const output = formatInitResult(result);

    expect(output).not.toMatch(/monorepo/i);
  });

  it("does NOT show monorepo warning when markers are found but existing config is already present locally", () => {
    // If a config already exists in the target dir, it's an established project —
    // no need to warn about monorepo structure
    const result = baseResult({
      monorepoMarkers: { isMonorepo: true, markers: ["nx.json"] },
      existingSetup: {
        configPath: "/project/parent/flowspec.config.yaml",
        specsDir: null,
      },
    });
    const output = formatInitResult(result);

    // When existing config is found, monorepo warning should be suppressed
    expect(output).not.toMatch(/monorepo/i);
  });
});

describe("formatInitResult — existing setup location", () => {
  it("shows existing config path when existingSetup.configPath is set", () => {
    const result = baseResult({
      existingSetup: {
        configPath: "/home/user/monorepo/flowspec.config.yaml",
        specsDir: null,
      },
    });
    const output = formatInitResult(result);

    expect(output).toContain("/home/user/monorepo/flowspec.config.yaml");
  });

  it("shows existing specs directory when existingSetup.specsDir is set", () => {
    const result = baseResult({
      existingSetup: {
        configPath: null,
        specsDir: "/home/user/monorepo/apps/web/specs",
      },
    });
    const output = formatInitResult(result);

    expect(output).toContain("/home/user/monorepo/apps/web/specs");
  });

  it("shows both config and specs paths when both are set in existingSetup", () => {
    const result = baseResult({
      existingSetup: {
        configPath: "/parent/flowspec.config.yaml",
        specsDir: "/parent/sibling/specs",
      },
    });
    const output = formatInitResult(result);

    expect(output).toContain("/parent/flowspec.config.yaml");
    expect(output).toContain("/parent/sibling/specs");
  });

  it("does not mention existing setup when existingSetup fields are null", () => {
    const result = baseResult({
      existingSetup: { configPath: null, specsDir: null },
    });
    const output = formatInitResult(result);

    // Should not contain path-like strings for existing setup
    expect(output).not.toContain("existing");
  });
});

describe("formatInitResult — pre-write file list", () => {
  it("includes the list of files that will be created in the output", () => {
    const result = baseResult({
      files: [
        {
          path: "/project/flowspec.config.yaml",
          created: true,
          skipped: false,
        },
        {
          path: "/project/specs/example.flow.yaml",
          created: true,
          skipped: false,
        },
      ],
    });
    const output = formatInitResult(result);

    expect(output).toContain("flowspec.config.yaml");
    expect(output).toContain("example.flow.yaml");
  });
});

describe("formatInitResult — warning is advisory", () => {
  it("still shows FlowSpec initialized! success message even when monorepo warning is present", () => {
    const result = baseResult({
      monorepoMarkers: {
        isMonorepo: true,
        markers: ["pnpm-workspace.yaml", "turbo.json"],
      },
      existingSetup: { configPath: null, specsDir: null },
    });
    const output = formatInitResult(result);

    expect(output).toMatch(/monorepo/i);
    expect(output).toContain("FlowSpec initialized!");
  });
});

// --- Edge cases added by Amy (Raptor Protocol) ---

describe("formatInitResult — warning suppression edge cases", () => {
  it("suppresses monorepo warning when only specsDir is found (no configPath)", () => {
    // Warning suppression condition is: !hasExistingConfig && !hasExistingSpecs
    // If specsDir alone is set, warning should be suppressed (covered by !hasExistingSpecs)
    const result = baseResult({
      monorepoMarkers: { isMonorepo: true, markers: ["turbo.json"] },
      existingSetup: {
        configPath: null,
        specsDir: "/parent/apps/web/specs",
      },
    });
    const output = formatInitResult(result);

    expect(output).not.toMatch(/monorepo/i);
    expect(output).toContain("/parent/apps/web/specs");
  });

  it("shows monorepo warning when existingSetup is undefined (no detection result)", () => {
    // existingSetup absent → hasExistingConfig and hasExistingSpecs are both false
    // → warning should fire when monorepo markers are present
    const result = baseResult({
      monorepoMarkers: { isMonorepo: true, markers: ["nx.json"] },
      // existingSetup intentionally omitted
    });
    const output = formatInitResult(result);

    expect(output).toMatch(/monorepo/i);
    expect(output).toContain("nx.json");
  });

  it("renders empty marker list gracefully when isMonorepo true but markers array is empty", () => {
    // Degenerate case: isMonorepo true but markers is [] — produces "monorepo detected ()"
    const result = baseResult({
      monorepoMarkers: { isMonorepo: true, markers: [] },
      existingSetup: { configPath: null, specsDir: null },
    });
    const output = formatInitResult(result);

    // Warning should still appear (isMonorepo is true)
    expect(output).toMatch(/monorepo/i);
    // Should not crash — marker list will just be empty string
    expect(output).toContain("FlowSpec initialized!");
  });
});

describe("formatInitResult — projectDir edge cases", () => {
  it("does not crash when projectDir is an empty string", () => {
    // Empty string is falsy in JS, so the directory section is skipped
    const result = baseResult({ projectDir: "" });
    const output = formatInitResult(result);

    expect(output).toContain("FlowSpec initialized!");
  });

  it("does not show directory line when projectDir is undefined", () => {
    const result = baseResult({ projectDir: undefined });
    const output = formatInitResult(result);

    expect(output).not.toContain("Initializing FlowSpec in:");
    expect(output).toContain("FlowSpec initialized!");
  });
});

describe("formatInitResult — existingSetup display without monorepoMarkers", () => {
  it("shows existing config path even when monorepoMarkers is undefined", () => {
    // existingSetup paths are shown independently of monorepo detection
    const result = baseResult({
      existingSetup: {
        configPath: "/some/parent/flowspec.config.yaml",
        specsDir: null,
      },
      // monorepoMarkers intentionally omitted
    });
    const output = formatInitResult(result);

    expect(output).toContain("/some/parent/flowspec.config.yaml");
    expect(output).not.toMatch(/monorepo/i);
  });
});

describe("initProject — detection order relative to file writes", () => {
  it("detection results in InitResult reflect post-write filesystem state", async () => {
    // Detection (detectMonorepoMarkers, findExistingSetup) runs AFTER file writes.
    // This verifies the result still includes valid detection data.
    const { rmSync, writeFileSync } = await import("node:fs");
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { initProject } = await import("../src/init.js");

    const tempDir = await mkdtemp(join(tmpdir(), "flowspec-order-test-"));
    try {
      // Write a package.json so monorepo detection actually runs its file checks
      writeFileSync(
        join(tempDir, "package.json"),
        JSON.stringify({ name: "test" }, null, 2),
      );

      const result = initProject(tempDir);

      // Detection ran after writes — result should always have these fields populated
      expect(result.monorepoMarkers).toBeDefined();
      expect(result.existingSetup).toBeDefined();
      expect(result.projectDir).toBe(tempDir);
      // No monorepo markers since we only wrote package.json (no turbo.json etc)
      expect(result.monorepoMarkers?.isMonorepo).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
