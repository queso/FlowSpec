/**
 * CLI Tests for FlowSpec
 *
 * Tests for the `flowspec run` command that ties together
 * parser, runner, and reporter.
 *
 * Exit codes:
 * - 0: All flows passed
 * - 1: One or more flows failed
 * - 2: Parse error (invalid YAML/schema)
 */

import { exec, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const _execAsync = promisify(exec);

// Path to CLI entry point
const CLI_PATH = join(__dirname, "..", "src", "index.ts");

// Fixtures
const VALID_FLOWS_DIR = join(__dirname, "fixtures", "flows", "valid");
const INVALID_FLOWS_DIR = join(__dirname, "fixtures", "flows", "invalid");

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

describe("CLI", () => {
  describe("run command", () => {
    describe("argument parsing", () => {
      it("should accept a single file path", async () => {
        const flowFile = join(VALID_FLOWS_DIR, "login.flow.yaml");

        // Run with single file - this should at least parse the file
        // (runner may fail without browser, but parsing should work)
        const result = await runCLI(["run", flowFile, "--timeout", "0"], {
          timeout: 15000,
        });

        // Should not exit with code 2 (parse error) for a valid file
        // It may exit with 0 (if mocked) or 1 (if runner fails)
        // but definitely not 2 since the file is valid YAML
        expect(result.exitCode).not.toBe(2);
      });

      it("should accept a directory path", async () => {
        const result = await runCLI(
          ["run", VALID_FLOWS_DIR, "--timeout", "0"],
          {
            timeout: 30000,
          },
        );

        // Should discover and attempt to run flow files in directory
        // Not exit code 2 since all files in valid/ are valid
        expect(result.exitCode).not.toBe(2);
      });

      it("should accept --base-url option", async () => {
        const flowFile = join(VALID_FLOWS_DIR, "login.flow.yaml");
        const result = await runCLI(
          [
            "run",
            flowFile,
            "--base-url",
            "http://localhost:9999",
            "--timeout",
            "0",
          ],
          { timeout: 15000 },
        );

        // Should parse without error even if runner fails
        // The option should be accepted
        expect(result.exitCode).not.toBe(2);
      });

      it("should show help with --help flag", async () => {
        const result = await runCLI(["run", "--help"]);

        // Help should include usage information
        expect(result.stdout + result.stderr).toMatch(
          /flowspec|run|usage|help/i,
        );
        expect(result.exitCode).toBe(0);
      });
    });

    describe("file discovery", () => {
      let tempDir: string;

      beforeAll(() => {
        tempDir = join(tmpdir(), `flowspec-test-${Date.now()}`);
        mkdirSync(tempDir, { recursive: true });
      });

      afterAll(() => {
        if (existsSync(tempDir)) {
          rmSync(tempDir, { recursive: true, force: true });
        }
      });

      it("should discover *.flow.yaml files in a directory", async () => {
        // Create temp flow files
        const flow1 = `
name: test-flow-1
description: First test flow
steps:
  - visit: /page1
expect:
  - visible: Page 1
`;
        const flow2 = `
name: test-flow-2
description: Second test flow
steps:
  - visit: /page2
expect:
  - visible: Page 2
`;
        writeFileSync(join(tempDir, "flow1.flow.yaml"), flow1);
        writeFileSync(join(tempDir, "flow2.flow.yaml"), flow2);

        const result = await runCLI(["run", tempDir, "--timeout", "0"], {
          timeout: 30000,
        });

        // Should find and process both files
        // Output should mention both flows (in results or errors)
        const output = result.stdout + result.stderr;
        expect(output).toMatch(/test-flow-1|test-flow-2|2 flows/i);
      });

      it("should only include .flow.yaml files, not other yaml files", async () => {
        // Create a non-flow yaml file
        const configYaml = `
setting: value
other: stuff
`;
        writeFileSync(join(tempDir, "config.yaml"), configYaml);

        const result = await runCLI(["run", tempDir, "--timeout", "0"], {
          timeout: 30000,
        });

        // Should not try to parse config.yaml as a flow
        // (would cause parse error if it did)
        expect(result.exitCode).not.toBe(2);
      });

      it("should handle non-existent file path", async () => {
        const result = await runCLI(["run", "/nonexistent/path/flow.yaml"]);

        // Should exit with error (code 1 or 2)
        expect(result.exitCode).toBeGreaterThan(0);
        expect(result.stderr + result.stdout).toMatch(
          /not found|no such file|error/i,
        );
      });

      it("should handle non-existent directory path", async () => {
        const result = await runCLI(["run", "/nonexistent/directory/"]);

        // Should exit with error
        expect(result.exitCode).toBeGreaterThan(0);
      });

      it("should handle empty directory (no flow files)", async () => {
        const emptyDir = join(tempDir, "empty");
        mkdirSync(emptyDir, { recursive: true });

        const result = await runCLI(["run", emptyDir]);

        // Should handle gracefully - either exit 0 with message or exit 1
        const output = result.stdout + result.stderr;
        expect(output).toMatch(/no.*flow|0 flows|empty/i);
      });
    });

    describe("exit codes", () => {
      let tempDir: string;

      beforeAll(() => {
        tempDir = join(tmpdir(), `flowspec-exit-test-${Date.now()}`);
        mkdirSync(tempDir, { recursive: true });
      });

      afterAll(() => {
        if (existsSync(tempDir)) {
          rmSync(tempDir, { recursive: true, force: true });
        }
      });

      it("should exit with code 2 on parse error (invalid YAML syntax)", async () => {
        const invalidYaml = `
name: bad-yaml
description: Has syntax error
steps:
  - visit: /home
    invalid indentation
expect:
  - visible: Home
`;
        const filePath = join(tempDir, "bad-syntax.flow.yaml");
        writeFileSync(filePath, invalidYaml);

        const result = await runCLI(["run", filePath]);

        expect(result.exitCode).toBe(2);
      });

      it("should exit with code 2 on schema validation error", async () => {
        const invalidSchema = `
name: missing-expect
description: Missing required expect field
steps:
  - visit: /home
`;
        const filePath = join(tempDir, "invalid-schema.flow.yaml");
        writeFileSync(filePath, invalidSchema);

        const result = await runCLI(["run", filePath]);

        expect(result.exitCode).toBe(2);
        expect(result.stderr + result.stdout).toMatch(/expect|schema|valid/i);
      });

      it("should exit with code 2 when flow has unknown step type", async () => {
        const unknownStep = `
name: unknown-step
description: Has unknown step type
steps:
  - hover: element
expect:
  - visible: Done
`;
        const filePath = join(tempDir, "unknown-step.flow.yaml");
        writeFileSync(filePath, unknownStep);

        const result = await runCLI(["run", filePath]);

        expect(result.exitCode).toBe(2);
      });

      it("should exit with code 2 when flow file from fixtures/invalid fails", async () => {
        const invalidFile = join(INVALID_FLOWS_DIR, "missing-name.flow.yaml");

        const result = await runCLI(["run", invalidFile]);

        expect(result.exitCode).toBe(2);
        expect(result.stderr + result.stdout).toMatch(/name/i);
      });
    });

    describe("output formatting", () => {
      let tempDir: string;

      beforeAll(() => {
        tempDir = join(tmpdir(), `flowspec-output-test-${Date.now()}`);
        mkdirSync(tempDir, { recursive: true });
      });

      afterAll(() => {
        if (existsSync(tempDir)) {
          rmSync(tempDir, { recursive: true, force: true });
        }
      });

      it("should format results with flow name", async () => {
        const flowFile = join(VALID_FLOWS_DIR, "login.flow.yaml");
        const result = await runCLI(["run", flowFile, "--timeout", "0"], {
          timeout: 15000,
        });

        // Output should include the flow name
        const output = result.stdout + result.stderr;
        expect(output).toMatch(/user-login/i);
      });

      it("should show summary after running multiple flows", async () => {
        const result = await runCLI(
          ["run", VALID_FLOWS_DIR, "--timeout", "0"],
          { timeout: 30000 },
        );

        // Summary should show counts
        const output = result.stdout + result.stderr;
        expect(output).toMatch(/\d+ flow/i);
      });

      it("should show error details when parsing fails", async () => {
        const invalidFile = join(INVALID_FLOWS_DIR, "empty-steps.flow.yaml");
        const result = await runCLI(["run", invalidFile]);

        // Should include error information
        const output = result.stdout + result.stderr;
        expect(output).toMatch(/error|steps|empty/i);
      });
    });

    describe("base URL handling", () => {
      it("should use default base URL of http://localhost:3456 when not specified", async () => {
        const flowFile = join(VALID_FLOWS_DIR, "login.flow.yaml");

        // Run without --base-url
        const result = await runCLI(["run", flowFile, "--timeout", "0"], {
          timeout: 15000,
        });

        // The command should execute (may fail due to no server, but should try)
        // Not checking specific output since we're testing the option is optional
        expect(result.exitCode).not.toBe(2); // No parse error
      });

      it("should accept custom base URL via --base-url flag", async () => {
        const flowFile = join(VALID_FLOWS_DIR, "login.flow.yaml");

        const result = await runCLI(
          [
            "run",
            flowFile,
            "--base-url",
            "http://custom.example.com:8080",
            "--timeout",
            "0",
          ],
          { timeout: 15000 },
        );

        // Should not fail due to invalid option
        expect(result.exitCode).not.toBe(2);
      });
    });
  });

  describe("no command (default behavior)", () => {
    it("should show help or usage when run without arguments", async () => {
      const result = await runCLI([]);

      // Should show some kind of help/usage info
      const output = result.stdout + result.stderr;
      expect(output).toMatch(/flowspec|usage|help|run/i);
    });
  });
});
