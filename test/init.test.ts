/**
 * Tests for the `flowspec init` command
 *
 * Verifies that init creates the correct files and directories,
 * handles existing files gracefully, and updates package.json.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CLAUDE_SETTINGS_CONTENT,
  DEFAULT_CONFIG_CONTENT,
  DEFAULT_EXAMPLE_FLOW_CONTENT,
  FLOWSPEC_HOOK_MARKER,
  formatInitResult,
  initProject,
} from "../src/init";

// Path to CLI entry point
const CLI_PATH = join(__dirname, "..", "src", "index.ts");

/**
 * Run the CLI with given arguments and return stdout, stderr, and exit code
 */
async function runCLI(
  args: string[],
  options: { cwd?: string; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const timeout = options.timeout ?? 5000;
  const cwd = options.cwd ?? join(__dirname, "..");

  return new Promise((resolve) => {
    const child = spawn("bun", ["run", CLI_PATH, ...args], {
      cwd,
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

describe("initProject", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `flowspec-init-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("file creation", () => {
    it("should create flowspec.config.yaml with correct content", () => {
      const result = initProject(tempDir);

      expect(result.success).toBe(true);

      const configPath = join(tempDir, "flowspec.config.yaml");
      expect(existsSync(configPath)).toBe(true);

      const content = readFileSync(configPath, "utf-8");
      expect(content).toBe(DEFAULT_CONFIG_CONTENT);
    });

    it("should create specs/example.flow.yaml with correct content", () => {
      const result = initProject(tempDir);

      expect(result.success).toBe(true);

      const flowPath = join(tempDir, "specs", "example.flow.yaml");
      expect(existsSync(flowPath)).toBe(true);

      const content = readFileSync(flowPath, "utf-8");
      expect(content).toBe(DEFAULT_EXAMPLE_FLOW_CONTENT);
    });

    it("should create .claude/settings.local.json with correct content", () => {
      const result = initProject(tempDir);

      expect(result.success).toBe(true);

      const settingsPath = join(tempDir, ".claude", "settings.local.json");
      expect(existsSync(settingsPath)).toBe(true);

      const content = readFileSync(settingsPath, "utf-8");
      expect(content).toBe(DEFAULT_CLAUDE_SETTINGS_CONTENT);

      // Verify it's valid JSON with new hook format
      const parsed = JSON.parse(content);
      expect(parsed.hooks).toBeDefined();
      expect(parsed.hooks.PreToolUse).toBeInstanceOf(Array);

      const hook = parsed.hooks.PreToolUse[0];
      expect(hook.matcher).toBe("Edit|Write");
      expect(hook.hooks).toBeInstanceOf(Array);
      expect(hook.hooks[0].type).toBe("command");
      expect(hook.hooks[0].command).toContain(FLOWSPEC_HOOK_MARKER);
    });

    it("should create specs directory if it does not exist", () => {
      const result = initProject(tempDir);

      expect(result.success).toBe(true);
      expect(existsSync(join(tempDir, "specs"))).toBe(true);
    });

    it("should create .claude directory if it does not exist", () => {
      const result = initProject(tempDir);

      expect(result.success).toBe(true);
      expect(existsSync(join(tempDir, ".claude"))).toBe(true);
    });
  });

  describe("idempotency", () => {
    it("should not overwrite existing flowspec.config.yaml", () => {
      const configPath = join(tempDir, "flowspec.config.yaml");
      const existingContent = "# Custom config\nbaseUrl: http://custom.com\n";
      writeFileSync(configPath, existingContent);

      const result = initProject(tempDir);

      expect(result.success).toBe(true);

      const configResult = result.files.find((f) =>
        f.path.endsWith("flowspec.config.yaml"),
      );
      expect(configResult?.skipped).toBe(true);
      expect(configResult?.created).toBe(false);

      // Content should be unchanged
      const content = readFileSync(configPath, "utf-8");
      expect(content).toBe(existingContent);
    });

    it("should not overwrite existing specs/example.flow.yaml", () => {
      mkdirSync(join(tempDir, "specs"), { recursive: true });
      const flowPath = join(tempDir, "specs", "example.flow.yaml");
      const existingContent =
        "name: my-custom-flow\nsteps:\n  - visit: /custom\n";
      writeFileSync(flowPath, existingContent);

      const result = initProject(tempDir);

      expect(result.success).toBe(true);

      const flowResult = result.files.find((f) =>
        f.path.endsWith("example.flow.yaml"),
      );
      expect(flowResult?.skipped).toBe(true);

      // Content should be unchanged
      const content = readFileSync(flowPath, "utf-8");
      expect(content).toBe(existingContent);
    });

    it("should merge hook into existing .claude/settings.local.json", () => {
      mkdirSync(join(tempDir, ".claude"), { recursive: true });
      const settingsPath = join(tempDir, ".claude", "settings.local.json");
      const existingContent = '{"custom": "settings"}';
      writeFileSync(settingsPath, existingContent);

      const result = initProject(tempDir);

      expect(result.success).toBe(true);

      const settingsResult = result.files.find((f) =>
        f.path.endsWith("settings.local.json"),
      );
      expect(settingsResult?.merged).toBe(true);

      // Original keys should be preserved, hook should be added
      const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(parsed.custom).toBe("settings");
      expect(parsed.hooks.PreToolUse).toBeInstanceOf(Array);
      expect(parsed.hooks.PreToolUse).toHaveLength(1);
      expect(parsed.hooks.PreToolUse[0].matcher).toBe("Edit|Write");
    });

    it("should be safe to run multiple times", () => {
      // First run creates 3 files (config, example flow, settings)
      const result1 = initProject(tempDir);
      expect(result1.success).toBe(true);
      expect(result1.files.filter((f) => f.created).length).toBe(3);

      // Second run: all non-package.json files are skipped (hook already present)
      const result2 = initProject(tempDir);
      expect(result2.success).toBe(true);

      const nonPkgFiles = result2.files.filter(
        (f) => !f.path.endsWith("package.json"),
      );
      for (const file of nonPkgFiles) {
        expect(file.skipped).toBe(true);
      }
      expect(result2.files.filter((f) => f.created).length).toBe(0);
      expect(result2.files.filter((f) => f.merged).length).toBe(0);
    });

    it("should skip merge when flowspec hook already present", () => {
      mkdirSync(join(tempDir, ".claude"), { recursive: true });
      const settingsPath = join(tempDir, ".claude", "settings.local.json");
      // Write settings that already contain the hook with the marker
      const existing = {
        hooks: {
          PreToolUse: [
            {
              matcher: "Edit|Write",
              hooks: [
                {
                  type: "command",
                  command: `some-prefix ${FLOWSPEC_HOOK_MARKER} some-suffix`,
                },
              ],
            },
          ],
        },
      };
      writeFileSync(settingsPath, JSON.stringify(existing, null, 2));

      const result = initProject(tempDir);

      expect(result.success).toBe(true);
      const settingsResult = result.files.find((f) =>
        f.path.endsWith("settings.local.json"),
      );
      expect(settingsResult?.skipped).toBe(true);
    });

    it("should append hook to existing PreToolUse array", () => {
      mkdirSync(join(tempDir, ".claude"), { recursive: true });
      const settingsPath = join(tempDir, ".claude", "settings.local.json");
      // Write settings with another PreToolUse hook (not ours)
      const existing = {
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "echo other-hook" }],
            },
          ],
        },
      };
      writeFileSync(settingsPath, JSON.stringify(existing, null, 2));

      const result = initProject(tempDir);

      expect(result.success).toBe(true);
      const settingsResult = result.files.find((f) =>
        f.path.endsWith("settings.local.json"),
      );
      expect(settingsResult?.merged).toBe(true);

      const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(parsed.hooks.PreToolUse).toHaveLength(2);
      expect(parsed.hooks.PreToolUse[0].matcher).toBe("Bash");
      expect(parsed.hooks.PreToolUse[1].matcher).toBe("Edit|Write");
    });

    it("should handle unparseable settings.local.json gracefully", () => {
      mkdirSync(join(tempDir, ".claude"), { recursive: true });
      const settingsPath = join(tempDir, ".claude", "settings.local.json");
      const invalidJson = "{ not valid json !!!";
      writeFileSync(settingsPath, invalidJson);

      const result = initProject(tempDir);

      expect(result.success).toBe(true);
      const settingsResult = result.files.find((f) =>
        f.path.endsWith("settings.local.json"),
      );
      expect(settingsResult?.skipped).toBe(true);

      // File content should be unchanged
      const content = readFileSync(settingsPath, "utf-8");
      expect(content).toBe(invalidJson);
    });
  });

  describe("package.json handling", () => {
    it("should add test:e2e script when package.json exists", () => {
      const packageJsonPath = join(tempDir, "package.json");
      writeFileSync(
        packageJsonPath,
        JSON.stringify({ name: "test-project", scripts: {} }, null, 2),
      );

      const result = initProject(tempDir);

      expect(result.success).toBe(true);

      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
      expect(pkg.scripts["test:e2e"]).toBe("flowspec run");
    });

    it("should add scripts object if it does not exist", () => {
      const packageJsonPath = join(tempDir, "package.json");
      writeFileSync(
        packageJsonPath,
        JSON.stringify({ name: "test-project" }, null, 2),
      );

      const result = initProject(tempDir);

      expect(result.success).toBe(true);

      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
      expect(pkg.scripts).toBeDefined();
      expect(pkg.scripts["test:e2e"]).toBe("flowspec run");
    });

    it("should not overwrite existing test:e2e script", () => {
      const packageJsonPath = join(tempDir, "package.json");
      writeFileSync(
        packageJsonPath,
        JSON.stringify(
          {
            name: "test-project",
            scripts: { "test:e2e": "custom-command" },
          },
          null,
          2,
        ),
      );

      const result = initProject(tempDir);

      expect(result.success).toBe(true);

      const pkgResult = result.files.find((f) =>
        f.path.endsWith("package.json"),
      );
      expect(pkgResult?.skipped).toBe(true);

      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
      expect(pkg.scripts["test:e2e"]).toBe("custom-command");
    });

    it("should skip when package.json does not exist", () => {
      const result = initProject(tempDir);

      expect(result.success).toBe(true);

      const pkgResult = result.files.find((f) =>
        f.path.endsWith("package.json"),
      );
      expect(pkgResult?.skipped).toBe(true);
      expect(pkgResult?.created).toBe(false);
    });

    it("should preserve other scripts when adding test:e2e", () => {
      const packageJsonPath = join(tempDir, "package.json");
      writeFileSync(
        packageJsonPath,
        JSON.stringify(
          {
            name: "test-project",
            scripts: {
              test: "vitest",
              build: "tsc",
            },
          },
          null,
          2,
        ),
      );

      initProject(tempDir);

      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
      expect(pkg.scripts.test).toBe("vitest");
      expect(pkg.scripts.build).toBe("tsc");
      expect(pkg.scripts["test:e2e"]).toBe("flowspec run");
    });
  });

  describe("result reporting", () => {
    it("should report created files in result", () => {
      const result = initProject(tempDir);

      expect(result.files).toHaveLength(4);

      const configResult = result.files.find((f) =>
        f.path.endsWith("flowspec.config.yaml"),
      );
      expect(configResult?.created).toBe(true);
      expect(configResult?.skipped).toBe(false);
    });

    it("should report skipped files in result", () => {
      writeFileSync(join(tempDir, "flowspec.config.yaml"), "existing: content");

      const result = initProject(tempDir);

      const configResult = result.files.find((f) =>
        f.path.endsWith("flowspec.config.yaml"),
      );
      expect(configResult?.skipped).toBe(true);
      expect(configResult?.created).toBe(false);
    });
  });
});

describe("formatInitResult", () => {
  it("should format created files with checkmark", () => {
    const result = {
      success: true,
      files: [
        {
          path: "/project/flowspec.config.yaml",
          created: true,
          skipped: false,
        },
      ],
    };

    const output = formatInitResult(result);

    expect(output).toContain("Created");
    expect(output).toContain("flowspec.config.yaml");
  });

  it("should format skipped files with dot", () => {
    const result = {
      success: true,
      files: [
        {
          path: "/project/flowspec.config.yaml",
          created: false,
          skipped: true,
        },
      ],
    };

    const output = formatInitResult(result);

    expect(output).toContain("Skipped");
    expect(output).toContain("already exists");
  });

  it("should format errors with x mark", () => {
    const result = {
      success: false,
      files: [
        {
          path: "/project/flowspec.config.yaml",
          created: false,
          skipped: false,
          error: "Permission denied",
        },
      ],
    };

    const output = formatInitResult(result);

    expect(output).toContain("Failed");
    expect(output).toContain("Permission denied");
  });

  it("should include next steps on success", () => {
    const result = {
      success: true,
      files: [
        {
          path: "/project/flowspec.config.yaml",
          created: true,
          skipped: false,
        },
      ],
    };

    const output = formatInitResult(result);

    expect(output).toContain("FlowSpec initialized!");
    expect(output).toContain("Next steps:");
    expect(output).toContain("flowspec run");
  });

  it("should format merged files", () => {
    const result = {
      success: true,
      files: [
        {
          path: "/project/.claude/settings.local.json",
          created: false,
          skipped: false,
          merged: true,
        },
      ],
    };

    const output = formatInitResult(result);

    expect(output).toContain("Merged");
    expect(output).toContain("FlowSpec hook");
  });
});

describe("CLI init command", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `flowspec-cli-init-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should create files when run via CLI", async () => {
    const result = await runCLI(["init"], { cwd: tempDir });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Created");
    expect(existsSync(join(tempDir, "flowspec.config.yaml"))).toBe(true);
    expect(existsSync(join(tempDir, "specs", "example.flow.yaml"))).toBe(true);
    expect(existsSync(join(tempDir, ".claude", "settings.local.json"))).toBe(
      true,
    );
  });

  it("should show help message in output", async () => {
    const result = await runCLI(["init"], { cwd: tempDir });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("FlowSpec initialized!");
    expect(result.stdout).toContain("Next steps:");
  });

  it("should handle already initialized project gracefully", async () => {
    // First init
    await runCLI(["init"], { cwd: tempDir });

    // Second init
    const result = await runCLI(["init"], { cwd: tempDir });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Skipped");
  });

  it("should include init in help output", async () => {
    const result = await runCLI(["--help"]);

    expect(result.stdout).toContain("init");
    expect(result.stdout).toContain("Initialize FlowSpec");
  });
});

describe("default file contents validation", () => {
  it("DEFAULT_CONFIG_CONTENT should be valid YAML with expected structure", () => {
    const yaml = require("js-yaml");
    const parsed = yaml.load(DEFAULT_CONFIG_CONTENT);

    expect(parsed.baseUrl).toBe("http://localhost:3000");
    expect(parsed.timeout).toBe(10000);
    expect(parsed.specsDir).toBe("specs/");
  });

  it("DEFAULT_EXAMPLE_FLOW_CONTENT should be valid flow YAML", () => {
    const yaml = require("js-yaml");
    const parsed = yaml.load(DEFAULT_EXAMPLE_FLOW_CONTENT);

    expect(parsed.name).toBe("example-flow");
    expect(parsed.description).toBeDefined();
    expect(parsed.steps).toBeInstanceOf(Array);
    expect(parsed.steps.length).toBeGreaterThan(0);
    expect(parsed.expect).toBeInstanceOf(Array);
    expect(parsed.expect.length).toBeGreaterThan(0);
  });

  it("DEFAULT_CLAUDE_SETTINGS_CONTENT should be valid JSON with hook", () => {
    const parsed = JSON.parse(DEFAULT_CLAUDE_SETTINGS_CONTENT);

    expect(parsed.hooks).toBeDefined();
    expect(parsed.hooks.PreToolUse).toBeInstanceOf(Array);

    const hook = parsed.hooks.PreToolUse[0];
    expect(hook.matcher).toBe("Edit|Write");
    expect(hook.hooks).toBeInstanceOf(Array);
    expect(hook.hooks[0].type).toBe("command");
    expect(hook.hooks[0].command).toContain(FLOWSPEC_HOOK_MARKER);
  });
});
