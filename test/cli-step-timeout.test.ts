/**
 * Post-mission sweep fix M2: the CLI step process-kill deadline is its OWN
 * config/CLI key (`stepTimeout` / `--step-timeout`), separate from the
 * assertion-retry budget (`timeout` / `--timeout`).
 *
 * Two defects this file pins:
 *  1. One `timeout` value used to mean both "how long to keep re-checking an
 *     assertion" (web-harmless, defaults to 10000ms) and "how long before a
 *     run step's process is killed" (CLI-fatal). Any real command that takes
 *     longer than the assertion budget — an install, a build, a network
 *     fetch — was silently killed and reported as "timed out".
 *  2. `--timeout 0` reached the spawn primitive unvalidated (mergeConfig uses
 *     `??`, so a CLI-supplied 0 bypassed the config schema's `.positive()`),
 *     arming a zero-delay kill. The kill deadline now has its own flag, and
 *     that flag rejects 0/negative/non-integer values with exit 2 before any
 *     flow runs.
 *
 * The assertion-retry `timeout` key keeps its existing meaning and its
 * existing tolerance of 0 ("no retries"), which is why the flag-level
 * validation lives on the new key only.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCliFlow } from "../src/cli-runner";
import {
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  DEFAULT_STEP_TIMEOUT,
  loadConfigFile,
  mergeConfig,
} from "../src/config";
import { runFlow } from "../src/runner";
import type { CliFlowSpec } from "../src/types";

const CLI_PATH = join(__dirname, "..", "src", "index.ts");
const execPath = process.execPath;

const ownedDirs: string[] = [];

function ownedTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "flowspec-step-timeout-"));
  ownedDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of ownedDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function cliFlow(steps: Record<string, unknown>[]): CliFlowSpec {
  return {
    name: "cli-flow",
    description: "A cli flow",
    surface: "cli",
    steps,
    expect: [{ exit_code: 0 }],
  } as unknown as CliFlowSpec;
}

/** A run step that stays alive for `ms` and then exits 0. */
function sleepStep(ms: number): Record<string, unknown> {
  return { run: [execPath, "-e", `setTimeout(()=>{},${ms})`] };
}

function writeConfig(dir: string, contents: string): string {
  const configPath = join(dir, CONFIG_FILE_NAME);
  writeFileSync(configPath, contents);
  return configPath;
}

async function runCLI(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn("bun", ["run", CLI_PATH, ...args], {
      cwd,
      timeout: 20000,
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
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    child.on("error", (error) => {
      resolve({ stdout, stderr: stderr + error.message, exitCode: 1 });
    });
  });
}

describe("config: stepTimeout is a distinct key from timeout", () => {
  it("defaults stepTimeout to a realistic process deadline, well past the assertion budget", () => {
    const dir = ownedTempDir();
    const configPath = writeConfig(dir, "baseUrl: http://custom.com\n");

    const config = loadConfigFile(configPath);

    // The assertion-retry budget keeps its own, unchanged default...
    expect(config.timeout).toBe(10000);
    // ...while the process-kill deadline is its own key with a default that
    // does not kill an install/build/network fetch mid-flight.
    expect(config.stepTimeout).toBe(DEFAULT_STEP_TIMEOUT);
    expect(DEFAULT_STEP_TIMEOUT).toBeGreaterThanOrEqual(60000);
    expect(DEFAULT_CONFIG.stepTimeout).toBe(DEFAULT_STEP_TIMEOUT);
  });

  it("loads an explicit stepTimeout without disturbing timeout", () => {
    const dir = ownedTempDir();
    const configPath = writeConfig(dir, "timeout: 2000\nstepTimeout: 120000\n");

    const config = loadConfigFile(configPath);

    expect(config.timeout).toBe(2000);
    expect(config.stepTimeout).toBe(120000);
  });

  it.each([
    ["zero", "0"],
    ["negative", "-1"],
    ["fractional", "1500.5"],
    ["non-numeric", '"soon"'],
  ])("rejects a %s stepTimeout, naming the field", (_label, value) => {
    const dir = ownedTempDir();
    const configPath = writeConfig(dir, `stepTimeout: ${value}\n`);

    expect(() => loadConfigFile(configPath)).toThrow(/invalid configuration/i);
    try {
      loadConfigFile(configPath);
      throw new Error("expected loadConfigFile to throw");
    } catch (error) {
      expect((error as Error).message).toContain("stepTimeout");
    }
  });

  it("carries stepTimeout through mergeConfig, with a CLI value winning over the config value", () => {
    const config = {
      baseUrl: "http://config.com",
      timeout: 10000,
      stepTimeout: 60000,
      specsDir: "specs/",
    };

    expect(mergeConfig(config, {}).stepTimeout).toBe(60000);
    expect(mergeConfig(config, { stepTimeout: 90000 }).stepTimeout).toBe(90000);
    // The two keys stay independent through the merge.
    expect(mergeConfig(config, { stepTimeout: 90000 }).timeout).toBe(10000);
    expect(mergeConfig(config, { timeout: 250 }).stepTimeout).toBe(60000);
  });
});

describe("--step-timeout flag validation", () => {
  function projectWithCliFlow(): string {
    const dir = ownedTempDir();
    writeFileSync(
      join(dir, "quick.flow.yaml"),
      `name: quick-cli-flow
description: exits immediately
surface: cli
steps:
  - run: ["${execPath}", "-e", "process.exit(0)"]
expect:
  - exit_code: 0
`,
    );
    return dir;
  }

  it.each([
    ["zero", "0"],
    ["negative", "-5"],
    ["non-numeric", "soon"],
    ["fractional", "1500.5"],
  ])(
    "rejects --step-timeout %s with exit code 2 and a message naming the flag",
    async (_label, value) => {
      const dir = projectWithCliFlow();

      const result = await runCLI(
        ["run", join(dir, "quick.flow.yaml"), "--step-timeout", value],
        dir,
      );

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("--step-timeout");
    },
    20000,
  );

  it("rejects --step-timeout with no value at all", async () => {
    const dir = projectWithCliFlow();

    const result = await runCLI(
      ["run", join(dir, "quick.flow.yaml"), "--step-timeout"],
      dir,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--step-timeout");
  }, 20000);

  it("accepts a positive --step-timeout and runs the flow", async () => {
    const dir = projectWithCliFlow();

    const result = await runCLI(
      ["run", join(dir, "quick.flow.yaml"), "--step-timeout", "90000"],
      dir,
    );

    expect(result.exitCode).toBe(0);
  }, 20000);

  it("still accepts --timeout 0: the assertion-retry budget is unchanged by this split", async () => {
    const dir = projectWithCliFlow();

    const result = await runCLI(
      ["run", join(dir, "quick.flow.yaml"), "--timeout", "0"],
      dir,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("--timeout");
  }, 20000);

  it("documents --step-timeout in the help output", async () => {
    const dir = ownedTempDir();

    const result = await runCLI(["run", "--help"], dir);

    const output = result.stdout + result.stderr;
    expect(output).toContain("--step-timeout");
  }, 20000);
});

describe("the assertion-retry budget no longer kills a run step", () => {
  it("does not kill a step that outlives the assertion-retry timeout", async () => {
    const cwd = ownedTempDir();
    // 300ms assertion budget, a step that lives ~1s: under the old
    // single-key behavior this was killed at 300ms and reported as a
    // timeout.
    const result = await runCliFlow(cliFlow([sleepStep(1000)]), {
      cwd,
      timeout: 300,
    });

    expect(result.error?.message ?? "").not.toContain("timed out");
    expect(result.success).toBe(true);
  }, 20000);

  it("does not kill a step that runs longer than the OLD 10s default deadline", async () => {
    const cwd = ownedTempDir();
    // The config default assertion budget (10000ms) used to double as the
    // process-kill deadline, so an 11s command was killed mid-flight. With
    // no stepTimeout supplied the new default (>= 60s) applies instead.
    const result = await runCliFlow(cliFlow([sleepStep(11000)]), {
      cwd,
      timeout: DEFAULT_CONFIG.timeout,
    });

    expect(result.error?.message ?? "").not.toContain("timed out");
    expect(result.success).toBe(true);
  }, 30000);

  it("still kills a step that exceeds the explicit stepTimeout option", async () => {
    const result = await runCliFlow(cliFlow([sleepStep(10000)]), {
      stepTimeout: 300,
    });

    expect(result.success).toBe(false);
    expect(result.error?.message.toLowerCase()).toContain("timed out");
    if (result.error?.workdir) {
      ownedDirs.push(result.error.workdir);
    }
  }, 20000);

  it("lets a step's own timeout win over the stepTimeout option", async () => {
    const result = await runCliFlow(
      cliFlow([{ ...sleepStep(10000), timeout: 300 }]),
      { stepTimeout: 60000 },
    );

    expect(result.success).toBe(false);
    expect(result.error?.message.toLowerCase()).toContain("timed out");
    if (result.error?.workdir) {
      ownedDirs.push(result.error.workdir);
    }
  }, 20000);

  it("threads stepTimeout from runFlow's options through the surface dispatch", async () => {
    const result = await runFlow(cliFlow([sleepStep(10000)]), {
      timeout: 5000,
      stepTimeout: 300,
    });

    expect(result.success).toBe(false);
    expect(result.error?.message.toLowerCase()).toContain("timed out");
    if (result.error?.workdir) {
      ownedDirs.push(result.error.workdir);
    }
  }, 20000);
});
