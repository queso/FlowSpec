/**
 * CLI setup-abort tests for FlowSpec (WI-772)
 *
 * Verifies that:
 *  - config-level setup is forwarded into every flow's runFlow call
 *  - a config-level setup failure aborts the run and marks remaining flows
 *    as skipped
 *  - a flow-level setup failure stays local to that flow and the run
 *    continues
 *  - a run where every failure is flow-level (no shared setup involved)
 *    never aborts
 *  - exit codes: 0 success / 1 flows-ran-and-failed / 2 misconfigured
 *  - a malformed config file — bad YAML, failed schema validation, or an
 *    unset ${VAR} reference — fails fast (before any flow parses or any
 *    browser session opens) with a clean stderr message and exit code 2
 *
 * These are real CLI subprocess + real-browser integration tests, following
 * test/cli.test.ts and test/runner-setup.test.ts patterns.
 */

import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { hasBrowserBinaries } from "./helpers/has-browser";
import { createTestServer, type TestServer } from "./server";

const CLI_PATH = join(__dirname, "..", "src", "index.ts");

async function runCLI(
  args: string[],
  options: { cwd: string; timeout?: number; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const timeout = options.timeout ?? 20000;

  return new Promise((resolve) => {
    const child = spawn("bun", ["run", CLI_PATH, ...args], {
      cwd: options.cwd,
      timeout,
      // Omitted -> inherit process.env, as every other test here expects.
      ...(options.env ? { env: options.env } : {}),
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

    child.on("error", (err) => {
      stderr += err.message;
      resolve({ stdout, stderr, exitCode: 1 });
    });
  });
}

let tempDir: string;

function freshTempDir(label: string): string {
  const dir = join(tmpdir(), `flowspec-cli-setup-abort-${label}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "flows"), { recursive: true });
  return dir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

const describeIfAgentBrowser = hasBrowserBinaries() ? describe : describe.skip;

describeIfAgentBrowser("CLI setup wiring and abort semantics", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = createTestServer();
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it("passes config-level setup into every flow's runFlow call", async () => {
    tempDir = freshTempDir("config-setup-runs-per-flow");
    writeFileSync(
      join(tempDir, "flowspec.config.yaml"),
      `baseUrl: ${server.baseUrl}
setup:
  - visit: /setup-auth.html
`,
    );
    writeFileSync(
      join(tempDir, "flows", "a-flow.flow.yaml"),
      `name: flow-one
description: relies on config-level setup
steps:
  - visit: /session-check.html
expect:
  - visible: Authenticated
`,
    );
    writeFileSync(
      join(tempDir, "flows", "b-flow.flow.yaml"),
      `name: flow-two
description: also relies on config-level setup
steps:
  - visit: /session-check.html
expect:
  - visible: Authenticated
`,
    );

    const result = await runCLI(
      ["run", join(tempDir, "flows"), "--timeout", "2000"],
      {
        cwd: tempDir,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("flow-one");
    expect(result.stdout).toContain("flow-two");
    expect(result.stdout).not.toContain("Not authenticated");
  });

  it("aborts the run and marks remaining flows as skipped when config-level setup fails", async () => {
    tempDir = freshTempDir("config-setup-fails-aborts");
    writeFileSync(
      join(tempDir, "flowspec.config.yaml"),
      `baseUrl: ${server.baseUrl}
setup:
  - click: Nonexistent Element ZZZ
`,
    );
    for (const [file, name] of [
      ["a-flow.flow.yaml", "flow-a"],
      ["b-flow.flow.yaml", "flow-b"],
      ["c-flow.flow.yaml", "flow-c"],
    ]) {
      writeFileSync(
        join(tempDir, "flows", file),
        `name: ${name}
description: never reached
steps:
  - visit: /dashboard.html
expect:
  - visible: Dashboard
`,
      );
    }

    const result = await runCLI(
      ["run", join(tempDir, "flows"), "--timeout", "2000"],
      {
        cwd: tempDir,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Setup step 0");
    expect(result.stdout).toMatch(/skip/i);
    // The abort is a decision the run made on the user's behalf, so it has to
    // say so — otherwise "skipped" flows look like an unexplained truncation.
    expect(result.stdout).toMatch(/Aborting run/);
    expect(result.stdout).toContain("flowspec.config.yaml");
    // The two skipped flows never ran, so no "Step N:" execution line for
    // them. The one real step line is rendered lowercase as "Setup step 0:"
    // per WI-771's reporter contract (test/reporter-setup.test.ts pins the
    // lowercase "Setup step N:" form) — match case-insensitively so this
    // counts that line rather than silently matching zero lines.
    const stepLineCount = (result.stdout.match(/step \d+:/gi) || []).length;
    expect(stepLineCount).toBe(1); // only the setup failure's own step line
    expect(result.stdout).toContain("3 flows: 0 passed, 1 failed, 2 skipped");
  });

  it("keeps a flow-level setup failure local; the run continues and a later flow using config-level setup still succeeds", async () => {
    tempDir = freshTempDir("flow-setup-fails-local");
    writeFileSync(
      join(tempDir, "flowspec.config.yaml"),
      `baseUrl: ${server.baseUrl}
setup:
  - visit: /setup-auth.html
`,
    );
    writeFileSync(
      join(tempDir, "flows", "a-flow.flow.yaml"),
      `name: flow-with-own-broken-setup
description: has its own failing setup, overriding config-level setup
setup:
  - click: Nonexistent Element ZZZ
steps:
  - visit: /dashboard.html
expect:
  - visible: Dashboard
`,
    );
    writeFileSync(
      join(tempDir, "flows", "b-flow.flow.yaml"),
      `name: flow-using-config-setup
description: relies on config-level setup and must still run
steps:
  - visit: /session-check.html
expect:
  - visible: Authenticated
`,
    );

    const result = await runCLI(
      ["run", join(tempDir, "flows"), "--timeout", "2000"],
      {
        cwd: tempDir,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("flow-with-own-broken-setup");
    expect(result.stdout).toContain("flow-using-config-setup");
    expect(result.stdout).toContain("2 flows: 1 passed, 1 failed");
    expect(result.stdout).not.toMatch(/skip/i);
  });

  it("does not abort when every failure is flow-level (no shared setup involved)", async () => {
    tempDir = freshTempDir("all-flow-level-failures-no-abort");
    writeFileSync(
      join(tempDir, "flowspec.config.yaml"),
      `baseUrl: ${server.baseUrl}
setup:
  - visit: /setup-auth.html
`,
    );
    for (const [file, name] of [
      ["a-flow.flow.yaml", "flow-a"],
      ["b-flow.flow.yaml", "flow-b"],
    ]) {
      writeFileSync(
        join(tempDir, "flows", file),
        `name: ${name}
description: has its own failing setup
setup:
  - click: Nonexistent Element ZZZ
steps:
  - visit: /dashboard.html
expect:
  - visible: Dashboard
`,
      );
    }

    const result = await runCLI(
      ["run", join(tempDir, "flows"), "--timeout", "2000"],
      {
        cwd: tempDir,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("2 flows: 0 passed, 2 failed");
    expect(result.stdout).not.toMatch(/skip/i);
  });

  // This test makes two sequential runCLI calls, each with the default 20s
  // subprocess timeout (see `runCLI`'s `timeout` option default above), so
  // the worst case is 40s — past the 30s per-test budget the suite runs
  // under (`bun run test`). Give it a per-test timeout via bun:test's third
  // argument to it() so it doesn't flake on slower CI.
  it("exits 0 on success and 1 on failure exactly as today when no setup is configured anywhere", async () => {
    tempDir = freshTempDir("no-setup-regression");
    // No flowspec.config.yaml at all -> DEFAULT_CONFIG, no setup.
    writeFileSync(
      join(tempDir, "flows", "pass.flow.yaml"),
      `name: no-setup-pass
description: ordinary passing flow, no setup anywhere
steps:
  - visit: ${server.baseUrl}/dashboard.html
expect:
  - visible: Dashboard
`,
    );

    const passResult = await runCLI(
      ["run", join(tempDir, "flows"), "--timeout", "2000"],
      { cwd: tempDir },
    );
    expect(passResult.exitCode).toBe(0);

    writeFileSync(
      join(tempDir, "flows", "fail.flow.yaml"),
      `name: no-setup-fail
description: ordinary failing flow, no setup anywhere
steps:
  - visit: ${server.baseUrl}/dashboard.html
  - click: Nonexistent Element ZZZ
expect:
  - visible: Dashboard
`,
    );

    const failResult = await runCLI(
      ["run", join(tempDir, "flows"), "--timeout", "2000"],
      { cwd: tempDir },
    );
    expect(failResult.exitCode).toBe(1);
    expect(failResult.stdout).not.toMatch(/skip/i);
  }, 45000);
});

describe("CLI malformed config exit-code contract", () => {
  it("exits 2 with a clean stderr message (no 'Unexpected error:' prefix) for invalid config YAML syntax, before any flow parses", async () => {
    tempDir = freshTempDir("malformed-config-yaml");
    writeFileSync(
      join(tempDir, "flowspec.config.yaml"),
      "baseUrl: [\ninvalid yaml syntax\n",
    );
    writeFileSync(
      join(tempDir, "flows", "would-run.flow.yaml"),
      `name: would-run
description: must never be reached
steps:
  - visit: /home
expect:
  - visible: Home
`,
    );

    const result = await runCLI(
      ["run", join(tempDir, "flows"), "--timeout", "2000"],
      {
        cwd: tempDir,
      },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).not.toContain("Unexpected error:");
    expect(result.stderr + result.stdout).toMatch(/invalid yaml/i);
    expect(result.stdout).not.toContain("would-run");
    expect(result.stdout).not.toMatch(/\d+ flows?:/);
  });

  it("exits 2 with a clean stderr message (no 'Unexpected error:' prefix) for a config that fails schema validation, before any flow parses", async () => {
    tempDir = freshTempDir("malformed-config-schema");
    writeFileSync(
      join(tempDir, "flowspec.config.yaml"),
      "baseUrl: not-a-valid-url\n",
    );
    writeFileSync(
      join(tempDir, "flows", "would-run.flow.yaml"),
      `name: would-run
description: must never be reached
steps:
  - visit: /home
expect:
  - visible: Home
`,
    );

    const result = await runCLI(
      ["run", join(tempDir, "flows"), "--timeout", "2000"],
      {
        cwd: tempDir,
      },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).not.toContain("Unexpected error:");
    expect(result.stderr + result.stdout).toMatch(/invalid configuration/i);
    expect(result.stdout).not.toContain("would-run");
    expect(result.stdout).not.toMatch(/\d+ flows?:/);
  });

  // Title avoids a literal dollar-brace so Biome's noTemplateCurlyInString
  // stays quiet; the case under test is an unset ${VAR} config reference.
  it("exits 2 naming the variable and the config file when an interpolated variable is unset, before any flow parses", async () => {
    tempDir = freshTempDir("unset-config-var");
    const missingVar = "FLOWSPEC_TEST_DEFINITELY_UNSET";
    writeFileSync(
      join(tempDir, "flowspec.config.yaml"),
      `baseUrl: http://localhost:3000?token=\${${missingVar}}\n`,
    );
    writeFileSync(
      join(tempDir, "flows", "would-run.flow.yaml"),
      `name: would-run
description: must never be reached
steps:
  - visit: /home
expect:
  - visible: Home
`,
    );

    // Explicit env copy minus the variable: inheriting process.env would let a
    // stray export in the developer's shell (or CI) turn this green.
    const { [missingVar]: _omitted, ...env } = process.env;

    const result = await runCLI(
      ["run", join(tempDir, "flows"), "--timeout", "2000"],
      {
        cwd: tempDir,
        env,
      },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).not.toContain("Unexpected error:");
    expect(result.stderr).toContain(missingVar);
    // Assert the path by its two identifying parts rather than the exact
    // string: cwd resolution can prefix the temp dir (e.g. /private on macOS).
    expect(result.stderr).toContain("flowspec.config.yaml");
    expect(result.stderr).toContain(basename(tempDir));
    expect(result.stdout).not.toContain("would-run");
    expect(result.stdout).not.toMatch(/\d+ flows?:/);
  });
});
