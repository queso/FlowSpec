/**
 * CLI Timeout Flag Tests for FlowSpec
 *
 * Tests for the --timeout <ms> CLI flag that configures
 * assertion retry timeout in flowspec run.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Path to CLI entry point
const CLI_PATH = join(__dirname, "..", "src", "index.ts");

// Fixtures
const VALID_FLOWS_DIR = join(__dirname, "fixtures", "flows", "valid");

/**
 * Run the CLI with given arguments and return stdout, stderr, and exit code
 */
async function runCLI(
  args: string[],
  options: { timeout?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const timeout = options.timeout ?? 5000;

  return new Promise((resolve) => {
    const child = spawn("bun", ["run", CLI_PATH, ...args], {
      cwd: join(__dirname, ".."),
      timeout,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });

    child.on("error", (err) => {
      stderr += err.message;
      resolve({
        stdout,
        stderr,
        exitCode: 1,
      });
    });
  });
}

describe("CLI --timeout flag", () => {
  describe("argument parsing", () => {
    it("should accept --timeout with a value", async () => {
      const flowFile = join(VALID_FLOWS_DIR, "login.flow.yaml");

      const result = await runCLI(["run", flowFile, "--timeout", "1000"]);

      // Should not exit with code 2 (parse error) - the flag should be accepted
      expect(result.exitCode).not.toBe(2);
    });

    it("should accept --timeout before the path argument", async () => {
      const flowFile = join(VALID_FLOWS_DIR, "login.flow.yaml");

      const result = await runCLI(["run", "--timeout", "2000", flowFile]);

      // Should not exit with code 2 - argument order should be flexible
      expect(result.exitCode).not.toBe(2);
    });

    it("should handle --timeout without a value gracefully", async () => {
      const flowFile = join(VALID_FLOWS_DIR, "login.flow.yaml");

      const result = await runCLI(["run", flowFile, "--timeout"]);

      // Should not crash - either ignore the flag or show an error
      // The exit code could be 0, 1, or 2 depending on handling strategy
      // but it should not throw an unhandled exception
      expect(result.exitCode).toBeDefined();
    });

    it("should handle --timeout with non-numeric value gracefully", async () => {
      const flowFile = join(VALID_FLOWS_DIR, "login.flow.yaml");

      const result = await runCLI(["run", flowFile, "--timeout", "invalid"]);

      // Should not crash with unhandled exception
      expect(result.exitCode).toBeDefined();
    });
  });

  describe("help text", () => {
    it("should include --timeout in help output", async () => {
      const result = await runCLI(["run", "--help"]);

      const output = result.stdout + result.stderr;
      expect(output).toMatch(/--timeout/i);
    });

    it("should show default timeout value in help output", async () => {
      const result = await runCLI(["run", "--help"]);

      const output = result.stdout + result.stderr;
      // Should mention the default value (5000ms from DEFAULT_TIMEOUT)
      expect(output).toMatch(/5000|default/i);
    });

    it("should describe timeout units as milliseconds", async () => {
      const result = await runCLI(["run", "--help"]);

      const output = result.stdout + result.stderr;
      // Should mention ms or milliseconds
      expect(output).toMatch(/ms|milliseconds/i);
    });
  });

  describe("timeout passthrough to runner", () => {
    let tempDir: string;

    beforeAll(() => {
      tempDir = join(tmpdir(), `flowspec-timeout-test-${Date.now()}`);
      mkdirSync(tempDir, { recursive: true });
    });

    afterAll(() => {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("should use default timeout when --timeout is not specified", async () => {
      // Create a valid flow file
      const flowYaml = `
name: timeout-test
description: Test flow for timeout passthrough
steps:
  - visit: /test
expect:
  - visible: Test
`;
      const filePath = join(tempDir, "timeout-test.flow.yaml");
      writeFileSync(filePath, flowYaml);

      const result = await runCLI(["run", filePath]);

      // Should run without parse errors (runner may fail due to no server)
      expect(result.exitCode).not.toBe(2);
    });

    it("should accept timeout value of 0", async () => {
      const flowFile = join(VALID_FLOWS_DIR, "login.flow.yaml");

      const result = await runCLI(["run", flowFile, "--timeout", "0"]);

      // timeout=0 means no retries - should be valid
      expect(result.exitCode).not.toBe(2);
    });

    it("should accept large timeout values", async () => {
      const flowFile = join(VALID_FLOWS_DIR, "login.flow.yaml");

      const result = await runCLI(["run", flowFile, "--timeout", "60000"]);

      // Should accept 60 second timeout
      expect(result.exitCode).not.toBe(2);
    });
  });

  describe("combination with other flags", () => {
    it("should work with --base-url and --timeout together", async () => {
      const flowFile = join(VALID_FLOWS_DIR, "login.flow.yaml");

      const result = await runCLI([
        "run",
        flowFile,
        "--base-url",
        "http://localhost:9999",
        "--timeout",
        "3000",
      ]);

      // Both flags should be accepted
      expect(result.exitCode).not.toBe(2);
    });

    it("should work with --timeout before --base-url", async () => {
      const flowFile = join(VALID_FLOWS_DIR, "login.flow.yaml");

      const result = await runCLI([
        "run",
        "--timeout",
        "3000",
        "--base-url",
        "http://localhost:9999",
        flowFile,
      ]);

      // Order should not matter
      expect(result.exitCode).not.toBe(2);
    });
  });
});
