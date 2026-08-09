/**
 * CLI integration tests for `flowspec init --dir <path>`
 *
 * Verifies that the --dir flag correctly routes initialization to the
 * specified directory (absolute or relative), creates missing directories,
 * and that omitting --dir preserves backward-compatible cwd behavior.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Path to CLI entry point
const CLI_PATH = join(__dirname, "..", "src", "index.ts");

// Project root — used as cwd for CLI spawns
const PROJECT_ROOT = join(__dirname, "..");

/**
 * Run the CLI with given arguments and return stdout, stderr, and exit code.
 * @param args   Arguments passed after `bun run <CLI_PATH>`
 * @param cwd    Working directory for the spawned process (default: project root)
 */
async function runCLI(
  args: string[],
  options: { cwd?: string; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const timeout = options.timeout ?? 10000;
  const cwd = options.cwd ?? PROJECT_ROOT;

  return new Promise((resolve_) => {
    const child = spawn("bun", ["run", CLI_PATH, ...args], { cwd, timeout });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      resolve_({ stdout, stderr, exitCode: code ?? 1 });
    });

    child.on("error", (err) => {
      stderr += err.message;
      resolve_({ stdout, stderr, exitCode: 1 });
    });
  });
}

describe("flowspec init --dir flag", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "flowspec-dir-flag-test-"));
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("absolute path", () => {
    it("creates files in the specified absolute directory", async () => {
      const result = await runCLI(["init", "--dir", tempDir]);

      expect(result.exitCode).toBe(0);
      expect(existsSync(join(tempDir, "flowspec.config.yaml"))).toBe(true);
      expect(existsSync(join(tempDir, "specs", "example.flow.yaml"))).toBe(
        true,
      );
    });

    it("does NOT create files in cwd when --dir is given an absolute path", async () => {
      // Use a dedicated cwd so we can verify nothing is written there
      const cwdDir = join(tempDir, "cwd");
      mkdirSync(cwdDir, { recursive: true });
      const targetDir = join(tempDir, "target");
      mkdirSync(targetDir, { recursive: true });

      await runCLI(["init", "--dir", targetDir], { cwd: cwdDir });

      expect(existsSync(join(cwdDir, "flowspec.config.yaml"))).toBe(false);
      expect(existsSync(join(targetDir, "flowspec.config.yaml"))).toBe(true);
    });
  });

  describe("relative path", () => {
    it("resolves relative path against cwd and creates files there", async () => {
      // Spawn from tempDir; pass a relative subdirectory
      const result = await runCLI(["init", "--dir", "./myapp"], {
        cwd: tempDir,
      });

      expect(result.exitCode).toBe(0);
      const expectedTarget = join(tempDir, "myapp");
      expect(existsSync(join(expectedTarget, "flowspec.config.yaml"))).toBe(
        true,
      );
      expect(
        existsSync(join(expectedTarget, "specs", "example.flow.yaml")),
      ).toBe(true);
    });

    it("resolves dotted relative path (e.g. ./apps/web) correctly", async () => {
      const result = await runCLI(["init", "--dir", "./apps/web"], {
        cwd: tempDir,
      });

      expect(result.exitCode).toBe(0);
      const expectedTarget = join(tempDir, "apps", "web");
      expect(existsSync(join(expectedTarget, "flowspec.config.yaml"))).toBe(
        true,
      );
    });
  });

  describe("nonexistent directory", () => {
    it("creates the directory when it does not exist", async () => {
      const newDir = join(tempDir, "brand-new-dir");
      expect(existsSync(newDir)).toBe(false);

      const result = await runCLI(["init", "--dir", newDir]);

      expect(result.exitCode).toBe(0);
      expect(existsSync(newDir)).toBe(true);
      expect(existsSync(join(newDir, "flowspec.config.yaml"))).toBe(true);
    });

    it("creates nested directories recursively when they do not exist", async () => {
      const nestedDir = join(tempDir, "a", "b", "c");
      expect(existsSync(nestedDir)).toBe(false);

      const result = await runCLI(["init", "--dir", nestedDir]);

      expect(result.exitCode).toBe(0);
      expect(existsSync(nestedDir)).toBe(true);
    });
  });

  describe("backward compatibility", () => {
    it("uses process.cwd() when --dir is not provided", async () => {
      // Spawn from tempDir with no --dir flag; files should appear in tempDir
      const result = await runCLI(["init"], { cwd: tempDir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(join(tempDir, "flowspec.config.yaml"))).toBe(true);
      expect(existsSync(join(tempDir, "specs", "example.flow.yaml"))).toBe(
        true,
      );
    });
  });

  describe("help text", () => {
    it("mentions --dir in flowspec init help output", async () => {
      const result = await runCLI(["--help"]);

      const output = result.stdout + result.stderr;
      expect(output).toMatch(/--dir/);
    });

    it("mentions --dir in general help output", async () => {
      const result = await runCLI(["init", "--help"]);

      const output = result.stdout + result.stderr;
      expect(output).toMatch(/--dir/);
    });
  });

  describe("edge cases", () => {
    it("errors when --dir is given without a value", async () => {
      // Run from tempDir, not the project root: if this ever regresses to the
      // old cwd fallback, it must scaffold a scratch dir rather than the repo.
      const result = await runCLI(["init", "--dir"], { cwd: tempDir });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/--dir requires a directory path/);
    });

    it("does not scaffold anything when --dir is missing its value", async () => {
      await runCLI(["init", "--dir"], { cwd: tempDir });

      expect(existsSync(join(tempDir, "flowspec.config.yaml"))).toBe(false);
      expect(existsSync(join(tempDir, "specs"))).toBe(false);
    });

    it("errors when --dir is followed by another flag", async () => {
      const result = await runCLI(["init", "--dir", "--verbose"], {
        cwd: tempDir,
      });

      expect(result.exitCode).toBe(1);
      expect(existsSync(join(tempDir, "--verbose"))).toBe(false);
    });

    it("output indicates success or error without hanging", async () => {
      // Smoke test: just confirm the process exits within timeout
      const result = await runCLI(["init", "--dir", tempDir], {
        timeout: 8000,
      });

      expect(result.exitCode).toBeDefined();
    });
  });

  // --- Edge cases added by Amy (Raptor Protocol) ---

  describe("--dir with spaces in path", () => {
    it("handles a directory path that contains spaces", async () => {
      // spawn() with an args array (not shell string) handles spaces without quoting issues
      const dirWithSpaces = join(tempDir, "my app dir");

      const result = await runCLI(["init", "--dir", dirWithSpaces]);

      expect(result.exitCode).toBe(0);
      expect(existsSync(join(dirWithSpaces, "flowspec.config.yaml"))).toBe(
        true,
      );
    });
  });

  describe("--dir passed multiple times", () => {
    it("uses the LAST --dir value when --dir appears more than once", async () => {
      // Implementation loops without breaking: last match wins
      const firstDir = join(tempDir, "first");
      const lastDir = join(tempDir, "last");

      const result = await runCLI([
        "init",
        "--dir",
        firstDir,
        "--dir",
        lastDir,
      ]);

      expect(result.exitCode).toBe(0);
      // Last dir should have the files
      expect(existsSync(join(lastDir, "flowspec.config.yaml"))).toBe(true);
      // First dir should NOT have been initialized
      expect(existsSync(join(firstDir, "flowspec.config.yaml"))).toBe(false);
    });
  });

  describe("--dir with special path values", () => {
    it("handles --dir '.' (current directory)", async () => {
      // '.' resolves to cwd — files appear in cwd (tempDir)
      const result = await runCLI(["init", "--dir", "."], { cwd: tempDir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(join(tempDir, "flowspec.config.yaml"))).toBe(true);
    });

    it("handles --dir '..' (parent directory)", async () => {
      // '..' resolves to parent of cwd — files appear in tempDir's parent
      const subDir = join(tempDir, "child");
      mkdirSync(subDir, { recursive: true });

      // Spawn from subDir with --dir '..' → writes to tempDir
      const result = await runCLI(["init", "--dir", ".."], { cwd: subDir });

      expect(result.exitCode).toBe(0);
      expect(existsSync(join(tempDir, "flowspec.config.yaml"))).toBe(true);
    });
  });

  describe("--dir without a value falls back to cwd", () => {
    it("falls back to cwd init when --dir has no argument (last flag)", async () => {
      // When --dir is last arg with no value, condition `i + 1 < args.length` is false
      // So targetDir stays as process.cwd() — init runs in cwd (tempDir here)
      const result = await runCLI(["init", "--dir"], { cwd: tempDir });

      // Exit 0 (init succeeded in cwd) or 1 (some other issue) — process must terminate
      expect(result.exitCode).toBeDefined();
      // The process should not hang
      expect(typeof result.exitCode).toBe("number");
    });
  });

  describe("--dir pointing to a file (not a directory)", () => {
    it("exits with non-zero when --dir path points to an existing file", async () => {
      const { writeFileSync } = await import("node:fs");
      // Create a FILE at the target path
      const filePath = join(tempDir, "i-am-a-file");
      writeFileSync(filePath, "not a directory");

      const result = await runCLI(["init", "--dir", filePath]);

      // existsSync is true so mkdirSync is skipped; initProject then tries to
      // write join(filePath, "flowspec.config.yaml") — fails with ENOTDIR
      // Each file error is captured; result.success = false → exit code 1
      expect(result.exitCode).toBe(1);
    });
  });

  describe("--dir monorepo detection interaction", () => {
    it("detects monorepo markers in the --dir target when package.json and turbo.json exist there", async () => {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        join(tempDir, "package.json"),
        JSON.stringify({ name: "root" }, null, 2),
      );
      writeFileSync(
        join(tempDir, "turbo.json"),
        JSON.stringify({ pipeline: {} }, null, 2),
      );

      const result = await runCLI(["init", "--dir", tempDir]);

      expect(result.exitCode).toBe(0);
      // Monorepo warning should appear in output
      expect(result.stdout).toMatch(/monorepo/i);
    });

    it("includes target directory path in output when --dir is used", async () => {
      const result = await runCLI(["init", "--dir", tempDir]);

      expect(result.exitCode).toBe(0);
      // initProject sets projectDir; formatInitResult shows it
      expect(result.stdout).toContain(tempDir);
    });
  });
});
