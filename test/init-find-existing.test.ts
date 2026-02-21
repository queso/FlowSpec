/**
 * Tests for findExistingSetup function in src/init.ts
 *
 * Verifies that the function correctly searches upward for flowspec.config.yaml
 * and downward one level for specs/ directories containing .flow.yaml files.
 */

import {
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findExistingSetup } from "../src/init.js";

describe("findExistingSetup", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "flowspec-find-existing-test-"));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns null for both fields when nothing is found", () => {
    const subDir = join(tempDir, "project");
    mkdirSync(subDir, { recursive: true });

    const result = findExistingSetup(subDir);

    expect(result.configPath).toBeNull();
    expect(result.specsDir).toBeNull();
  });

  it("finds flowspec.config.yaml in a parent directory (upward search)", () => {
    // Create flowspec.config.yaml in tempDir (the parent)
    writeFileSync(
      join(tempDir, "flowspec.config.yaml"),
      "baseUrl: http://localhost:3000\n",
    );

    // Target dir is a child of tempDir
    const subDir = join(tempDir, "project");
    mkdirSync(subDir, { recursive: true });

    const result = findExistingSetup(subDir);

    expect(result.configPath).not.toBeNull();
    expect(result.configPath).toBe(join(tempDir, "flowspec.config.yaml"));
  });

  it("finds specs/ directory with .flow.yaml files in an immediate child directory (downward search, one level deep)", () => {
    // Create an immediate child (one level deep) with specs containing a .flow.yaml
    const childDir = join(tempDir, "apps");
    mkdirSync(join(childDir, "specs"), { recursive: true });
    writeFileSync(
      join(childDir, "specs", "login.flow.yaml"),
      "name: login\nsteps:\n  - visit: /login\n",
    );

    const result = findExistingSetup(tempDir);

    expect(result.specsDir).not.toBeNull();
    expect(result.specsDir).toBe(join(childDir, "specs"));
  });

  it("does NOT find specs/ in deeply nested child directories (only one level deep)", () => {
    // Create a specs dir two levels deep (apps/web/specs) — should NOT be found
    const deepDir = join(tempDir, "apps", "web");
    mkdirSync(join(deepDir, "specs"), { recursive: true });
    writeFileSync(
      join(deepDir, "specs", "flow.flow.yaml"),
      "name: flow\nsteps:\n  - visit: /\n",
    );

    const result = findExistingSetup(tempDir);

    expect(result.specsDir).toBeNull();
  });

  it("returns absolute paths for found items", () => {
    // Config in parent (tempDir)
    writeFileSync(
      join(tempDir, "flowspec.config.yaml"),
      "baseUrl: http://localhost:3000\n",
    );

    // Search from subDir; place specs one level deep (immediate child of subDir)
    const subDir = join(tempDir, "myproject");
    mkdirSync(subDir, { recursive: true });
    const childDir = join(subDir, "app");
    mkdirSync(join(childDir, "specs"), { recursive: true });
    writeFileSync(
      join(childDir, "specs", "main.flow.yaml"),
      "name: main\nsteps:\n  - visit: /\n",
    );

    const result = findExistingSetup(subDir);

    expect(result.configPath).not.toBeNull();
    expect(result.configPath).toMatch(/^\//);
    expect(result.specsDir).not.toBeNull();
    expect(result.specsDir).toMatch(/^\//);
  });

  it("finds both config and specs simultaneously", () => {
    // Config in parent (tempDir)
    writeFileSync(
      join(tempDir, "flowspec.config.yaml"),
      "baseUrl: http://localhost:3000\n",
    );

    // Specs one level deep from subDir (immediate child)
    const subDir = join(tempDir, "myproject");
    mkdirSync(subDir, { recursive: true });
    const childDir = join(subDir, "web");
    mkdirSync(join(childDir, "specs"), { recursive: true });
    writeFileSync(
      join(childDir, "specs", "checkout.flow.yaml"),
      "name: checkout\nsteps:\n  - visit: /checkout\n",
    );

    const result = findExistingSetup(subDir);

    expect(result.configPath).toBe(join(tempDir, "flowspec.config.yaml"));
    expect(result.specsDir).toBe(join(childDir, "specs"));
  });

  it("returns null for specsDir if specs/ exists in child but contains no .flow.yaml files", () => {
    // specs/ dir exists one level deep but only has non-flow files
    const childDir = join(tempDir, "packages");
    mkdirSync(join(childDir, "specs"), { recursive: true });
    writeFileSync(join(childDir, "specs", "README.md"), "# Specs\n");

    const result = findExistingSetup(tempDir);

    expect(result.specsDir).toBeNull();
  });

  it("does not find config file in the target directory itself (only searches parent dirs)", () => {
    // Place flowspec.config.yaml IN the target directory itself
    writeFileSync(
      join(tempDir, "flowspec.config.yaml"),
      "baseUrl: http://localhost:3000\n",
    );

    // Search from tempDir — config is in the same dir, should NOT be found
    const result = findExistingSetup(tempDir);

    expect(result.configPath).toBeNull();
  });

  it("finds config in grandparent directory (multiple levels up)", () => {
    // Config in grandparent
    writeFileSync(
      join(tempDir, "flowspec.config.yaml"),
      "baseUrl: http://localhost:3000\n",
    );

    // Target dir is two levels deep
    const deepSubDir = join(tempDir, "packages", "app");
    mkdirSync(deepSubDir, { recursive: true });

    const result = findExistingSetup(deepSubDir);

    expect(result.configPath).toBe(join(tempDir, "flowspec.config.yaml"));
  });

  it("returns null for specsDir if specs/ exists in target dir itself (only searches children)", () => {
    // specs/ with flow.yaml in the target directory itself
    mkdirSync(join(tempDir, "specs"), { recursive: true });
    writeFileSync(
      join(tempDir, "specs", "main.flow.yaml"),
      "name: main\nsteps:\n  - visit: /\n",
    );

    // Since downward search is for immediate children only, searching tempDir
    // should not return tempDir/specs as a child specs dir
    // (tempDir's specs is the target dir's own specs, not a child's)
    const result = findExistingSetup(tempDir);

    // specs in the target dir itself is not a "child" directory specs
    expect(result.specsDir).toBeNull();
  });

  // --- Edge cases added by Amy (Raptor Protocol) ---

  it("returns null for both fields when the target directory does not exist", () => {
    const nonExistentDir = join(tempDir, "does-not-exist");

    const result = findExistingSetup(nonExistentDir);

    // readdirSync on non-existent dir throws, caught → specsDir null
    // findConfigFile starts from parent (tempDir), which has no config
    expect(result.specsDir).toBeNull();
    expect(result.configPath).toBeNull();
  });

  it("returns null for specsDir when a child named specs is a file, not a directory", () => {
    // Create a child directory, then place a FILE called "specs" inside it
    const childDir = join(tempDir, "app");
    mkdirSync(childDir, { recursive: true });
    // "specs" is a file, not a directory
    writeFileSync(join(childDir, "specs"), "I am not a directory");

    const result = findExistingSetup(tempDir);

    // hasFlowYamlFiles will call readdirSync on a file path and throw,
    // returning false — so specsDir should be null
    expect(result.specsDir).toBeNull();
  });

  it("returns the first matched specs dir when multiple children each have specs/*.flow.yaml", () => {
    // Two children both have specs/ with .flow.yaml — result depends on readdir order
    const childA = join(tempDir, "aaa");
    const childB = join(tempDir, "zzz");
    mkdirSync(join(childA, "specs"), { recursive: true });
    mkdirSync(join(childB, "specs"), { recursive: true });
    writeFileSync(
      join(childA, "specs", "flow-a.flow.yaml"),
      "name: a\nsteps:\n  - visit: /a\n",
    );
    writeFileSync(
      join(childB, "specs", "flow-b.flow.yaml"),
      "name: b\nsteps:\n  - visit: /b\n",
    );

    const result = findExistingSetup(tempDir);

    // Implementation returns the first match in readdir order (OS-dependent).
    // We can only assert that exactly one is returned, not which one.
    expect(result.specsDir).not.toBeNull();
    const validPaths = [join(childA, "specs"), join(childB, "specs")];
    expect(validPaths).toContain(result.specsDir);
  });

  it("does NOT traverse symlinked child directories when searching for specs", async () => {
    // Create a real directory with specs OUTSIDE of tempDir (a sibling temp dir)
    const { mkdtemp: mkdtempFn } = await import("node:fs/promises");
    const realDir = await mkdtempFn(join(tmpdir(), "flowspec-symlink-target-"));
    try {
      mkdirSync(join(realDir, "specs"), { recursive: true });
      writeFileSync(
        join(realDir, "specs", "flow.flow.yaml"),
        "name: flow\nsteps:\n  - visit: /\n",
      );

      // Create a symlink inside tempDir pointing to the external real directory
      const symlinkChild = join(tempDir, "symlinked-app");
      symlinkSync(realDir, symlinkChild);

      const result = findExistingSetup(tempDir);

      // readdirSync with { withFileTypes: true } returns Dirent objects;
      // Dirent.isDirectory() returns false for symlinks to directories.
      // So the symlinked child is filtered out and specs inside are NOT found.
      expect(result.specsDir).toBeNull();
    } finally {
      rmSync(realDir, { recursive: true, force: true });
    }
  });
});
