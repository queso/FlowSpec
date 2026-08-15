/**
 * CLI header-wiring tests for FlowSpec
 *
 * Verifies that:
 *  - config-level `headers` reach every flow's runFlow call, so the browser
 *    session actually sends them (proved end-to-end against /echo-header)
 *  - a header-application failure aborts the run — headers are config-only,
 *    so the failure is always shared and every remaining flow would hit it —
 *    and says so, naming headers rather than setup
 *  - header values ride the existing config-fault contract: an unset ${VAR}
 *    inside a header value exits 2 with a clean message, before any flow
 *    parses or any browser session opens
 *
 * These are real CLI subprocess + real-browser integration tests, following
 * test/cli-setup-abort.test.ts and test/runner-headers.test.ts patterns.
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
  const dir = join(tmpdir(), `flowspec-cli-headers-${label}-${Date.now()}`);
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

describeIfAgentBrowser("CLI header wiring and abort semantics", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = createTestServer();
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  it("sends config-level headers with the flow's requests", async () => {
    tempDir = freshTempDir("config-headers-reach-request");
    writeFileSync(
      join(tempDir, "flowspec.config.yaml"),
      `baseUrl: ${server.baseUrl}
headers:
  x-flowspec-test: granted
`,
    );
    // /echo-header renders "Header: granted" only when the request actually
    // carried the header — client-side JS cannot forge that, so a passing
    // assertion is proof the header survived config -> runFlows -> runFlow.
    writeFileSync(
      join(tempDir, "flows", "a-flow.flow.yaml"),
      `name: header-flow
description: relies on config-level headers reaching the request
steps:
  - visit: /echo-header
expect:
  - visible: "Header: granted"
`,
    );

    const result = await runCLI(
      ["run", join(tempDir, "flows"), "--timeout", "2000"],
      {
        cwd: tempDir,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("header-flow");
    expect(result.stdout).not.toContain("No header received");
  });

  it("aborts the run and marks remaining flows as skipped when applying config-level headers fails", async () => {
    tempDir = freshTempDir("config-headers-fail-aborts");
    // A header name containing a space is rejected by the browser's
    // setExtraHTTPHeaders, which is what surfaces the phase:"headers" failure.
    writeFileSync(
      join(tempDir, "flowspec.config.yaml"),
      `baseUrl: ${server.baseUrl}
headers:
  "bad header": granted
`,
    );
    for (const [file, name] of [
      ["a-flow.flow.yaml", "flow-a"],
      ["b-flow.flow.yaml", "flow-b"],
    ]) {
      writeFileSync(
        join(tempDir, "flows", file),
        `name: ${name}
description: never reaches its steps
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
    expect(result.stdout).toContain("Failed to apply headers:");
    // The narrator line has to name what actually failed: reusing the setup
    // wording here would send the user hunting through a `setup:` block that
    // is fine (or absent).
    expect(result.stdout).toContain(
      "Aborting run: applying the shared headers",
    );
    expect(result.stdout).toContain("flowspec.config.yaml");
    expect(result.stdout).toMatch(/skip/i);
    expect(result.stdout).toContain("2 flows: 0 passed, 1 failed, 1 skipped");
  });
});

describe("CLI header config-fault contract", () => {
  // Title avoids a literal dollar-brace so Biome's noTemplateCurlyInString
  // stays quiet; the case under test is an unset ${VAR} header value.
  it("exits 2 naming the variable when a header value references an unset variable, before any flow parses", async () => {
    tempDir = freshTempDir("unset-header-var");
    const missingVar = "FLOWSPEC_HDR_TEST_UNSET";
    writeFileSync(
      join(tempDir, "flowspec.config.yaml"),
      `baseUrl: http://localhost:3000
headers:
  x-flowspec-test: \${${missingVar}}
`,
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
