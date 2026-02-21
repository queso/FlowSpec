/**
 * Tests for detectMonorepoMarkers function in src/init.ts
 *
 * Verifies that the function correctly identifies monorepo markers
 * (pnpm-workspace.yaml, turbo.json, nx.json, workspaces field in package.json)
 * and returns structured detection results.
 */

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectMonorepoMarkers } from "../src/init.js";

describe("detectMonorepoMarkers", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "flowspec-monorepo-test-"));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns isMonorepo: false and empty markers when no package.json exists", () => {
    const result = detectMonorepoMarkers(tempDir);

    expect(result.isMonorepo).toBe(false);
    expect(result.markers).toEqual([]);
  });

  it("returns isMonorepo: false and empty markers when package.json exists but no monorepo markers", () => {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({ name: "my-app", version: "1.0.0" }, null, 2),
    );

    const result = detectMonorepoMarkers(tempDir);

    expect(result.isMonorepo).toBe(false);
    expect(result.markers).toEqual([]);
  });

  it("detects pnpm-workspace.yaml as a marker when package.json exists", () => {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({ name: "my-monorepo" }, null, 2),
    );
    writeFileSync(
      join(tempDir, "pnpm-workspace.yaml"),
      "packages:\n  - 'packages/*'\n",
    );

    const result = detectMonorepoMarkers(tempDir);

    expect(result.isMonorepo).toBe(true);
    expect(result.markers).toContain("pnpm-workspace.yaml");
  });

  it("detects turbo.json as a marker when package.json exists", () => {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({ name: "my-monorepo" }, null, 2),
    );
    writeFileSync(
      join(tempDir, "turbo.json"),
      JSON.stringify({ pipeline: {} }, null, 2),
    );

    const result = detectMonorepoMarkers(tempDir);

    expect(result.isMonorepo).toBe(true);
    expect(result.markers).toContain("turbo.json");
  });

  it("detects nx.json as a marker when package.json exists", () => {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({ name: "my-monorepo" }, null, 2),
    );
    writeFileSync(
      join(tempDir, "nx.json"),
      JSON.stringify({ version: 2 }, null, 2),
    );

    const result = detectMonorepoMarkers(tempDir);

    expect(result.isMonorepo).toBe(true);
    expect(result.markers).toContain("nx.json");
  });

  it("detects workspaces field in package.json as a marker", () => {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify(
        {
          name: "my-monorepo",
          workspaces: ["packages/*"],
        },
        null,
        2,
      ),
    );

    const result = detectMonorepoMarkers(tempDir);

    expect(result.isMonorepo).toBe(true);
    expect(result.markers).toContain("workspaces");
  });

  it("detects multiple markers simultaneously", () => {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify(
        {
          name: "my-monorepo",
          workspaces: ["packages/*"],
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(tempDir, "turbo.json"),
      JSON.stringify({ pipeline: {} }, null, 2),
    );
    writeFileSync(
      join(tempDir, "pnpm-workspace.yaml"),
      "packages:\n  - 'packages/*'\n",
    );

    const result = detectMonorepoMarkers(tempDir);

    expect(result.isMonorepo).toBe(true);
    expect(result.markers).toContain("workspaces");
    expect(result.markers).toContain("turbo.json");
    expect(result.markers).toContain("pnpm-workspace.yaml");
    expect(result.markers.length).toBe(3);
  });

  it("skips ALL detection and returns false when turbo.json exists but no package.json", () => {
    writeFileSync(
      join(tempDir, "turbo.json"),
      JSON.stringify({ pipeline: {} }, null, 2),
    );

    const result = detectMonorepoMarkers(tempDir);

    expect(result.isMonorepo).toBe(false);
    expect(result.markers).toEqual([]);
  });

  it("skips ALL detection and returns false when nx.json exists but no package.json", () => {
    writeFileSync(
      join(tempDir, "nx.json"),
      JSON.stringify({ version: 2 }, null, 2),
    );

    const result = detectMonorepoMarkers(tempDir);

    expect(result.isMonorepo).toBe(false);
    expect(result.markers).toEqual([]);
  });

  it("skips ALL detection and returns false when pnpm-workspace.yaml exists but no package.json", () => {
    writeFileSync(
      join(tempDir, "pnpm-workspace.yaml"),
      "packages:\n  - 'packages/*'\n",
    );

    const result = detectMonorepoMarkers(tempDir);

    expect(result.isMonorepo).toBe(false);
    expect(result.markers).toEqual([]);
  });

  it("skips ALL detection when multiple marker files exist but no package.json", () => {
    writeFileSync(
      join(tempDir, "turbo.json"),
      JSON.stringify({ pipeline: {} }, null, 2),
    );
    writeFileSync(
      join(tempDir, "nx.json"),
      JSON.stringify({ version: 2 }, null, 2),
    );
    writeFileSync(
      join(tempDir, "pnpm-workspace.yaml"),
      "packages:\n  - 'packages/*'\n",
    );

    const result = detectMonorepoMarkers(tempDir);

    expect(result.isMonorepo).toBe(false);
    expect(result.markers).toEqual([]);
  });

  it("returns isMonorepo: true when any single marker is found with package.json present", () => {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({ name: "my-monorepo" }, null, 2),
    );
    writeFileSync(
      join(tempDir, "nx.json"),
      JSON.stringify({ version: 2 }, null, 2),
    );

    const result = detectMonorepoMarkers(tempDir);

    expect(result.isMonorepo).toBe(true);
    expect(result.markers.length).toBeGreaterThan(0);
  });

  // --- Edge cases added by Amy (Raptor Protocol) ---

  it("returns isMonorepo: false and empty markers when directory does not exist", () => {
    const nonExistentDir = join(tempDir, "does-not-exist");

    const result = detectMonorepoMarkers(nonExistentDir);

    expect(result.isMonorepo).toBe(false);
    expect(result.markers).toEqual([]);
  });

  it("still detects file markers when package.json is malformed/unparseable", () => {
    // Malformed package.json: existsSync returns true, but JSON.parse will throw
    writeFileSync(join(tempDir, "package.json"), "{ this is not valid json");
    writeFileSync(
      join(tempDir, "turbo.json"),
      JSON.stringify({ pipeline: {} }, null, 2),
    );

    const result = detectMonorepoMarkers(tempDir);

    // File markers are checked BEFORE the JSON parse attempt, so turbo.json is found
    expect(result.isMonorepo).toBe(true);
    expect(result.markers).toContain("turbo.json");
    // workspaces marker should NOT be present (parse failed)
    expect(result.markers).not.toContain("workspaces");
  });

  it("returns isMonorepo: false when package.json is malformed and no file markers exist", () => {
    writeFileSync(join(tempDir, "package.json"), "{ invalid json }");

    const result = detectMonorepoMarkers(tempDir);

    expect(result.isMonorepo).toBe(false);
    expect(result.markers).toEqual([]);
  });

  it("treats workspaces as an empty array as a monorepo marker", () => {
    // workspaces: [] is present but empty - implementation adds "workspaces" marker
    // because it only checks !== undefined, not truthiness or array length
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({ name: "my-app", workspaces: [] }, null, 2),
    );

    const result = detectMonorepoMarkers(tempDir);

    // Current implementation: workspaces !== undefined is true, so isMonorepo = true
    // This documents the behavior (empty workspaces array still triggers detection)
    expect(result.isMonorepo).toBe(true);
    expect(result.markers).toContain("workspaces");
  });

  it("detects workspaces in yarn object format { packages: [...] }", () => {
    // Yarn supports workspaces as an object: { packages: ['packages/*'] }
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify(
        { name: "my-monorepo", workspaces: { packages: ["packages/*"] } },
        null,
        2,
      ),
    );

    const result = detectMonorepoMarkers(tempDir);

    expect(result.isMonorepo).toBe(true);
    expect(result.markers).toContain("workspaces");
  });

  it("treats workspaces: null as a monorepo marker", () => {
    // workspaces: null is !== undefined, so implementation adds "workspaces" marker
    // This documents a potential bug: null workspaces should not indicate a monorepo
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({ name: "my-app", workspaces: null }, null, 2),
    );

    const result = detectMonorepoMarkers(tempDir);

    // Current implementation: workspaces !== undefined, so isMonorepo = true
    // This is a bug: null workspaces should not indicate a monorepo
    expect(result.isMonorepo).toBe(true);
    expect(result.markers).toContain("workspaces");
  });
});
