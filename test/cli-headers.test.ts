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

/**
 * The repeatable `--header "Name: value"` flag.
 *
 * Every passing case here is proved against /echo-header (and its sibling
 * /echo-header-2), which render the value of the REQUEST header the server
 * actually received — client-side JS cannot read request headers, so the page
 * text is evidence the header rode along, not evidence the flag parsed.
 */
describeIfAgentBrowser("CLI --header flag", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = createTestServer();
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
  });

  /** Config with a baseUrl and, optionally, its own headers block. */
  function writeProject(configBody: string, flowBody: string): void {
    writeFileSync(
      join(tempDir, "flowspec.config.yaml"),
      `baseUrl: ${server.baseUrl}\n${configBody}`,
    );
    writeFileSync(join(tempDir, "flows", "a-flow.flow.yaml"), flowBody);
  }

  it("sends a header supplied only on the command line", async () => {
    tempDir = freshTempDir("cli-header-alone");
    writeProject(
      "",
      `name: cli-header-flow
description: the header comes from the command line, not the config
steps:
  - visit: /echo-header
expect:
  - visible: "Header: granted"
`,
    );

    const result = await runCLI(
      [
        "run",
        join(tempDir, "flows"),
        "--timeout",
        "2000",
        "--header",
        "x-flowspec-test: granted",
      ],
      { cwd: tempDir },
    );

    expect(result.exitCode).toBe(0);
    // Guards against a green exit that never ran a flow at all.
    expect(result.stdout).toContain("1 flow: 1 passed, 0 failed");
    expect(result.stdout).not.toContain("No header received");
  });

  it("replaces the config headers block entirely rather than merging into it", async () => {
    tempDir = freshTempDir("cli-header-replaces");
    // The config sets the very header the page echoes. If the CLI flag merged
    // instead of replacing, that config header would survive and the page
    // would say "Header: from-config".
    writeProject(
      `headers:
  x-flowspec-test: from-config
`,
      `name: cli-header-replaces-config
description: an unrelated CLI header must displace the whole config block
steps:
  - visit: /echo-header
expect:
  - visible: "No header received"
`,
    );

    const result = await runCLI(
      [
        "run",
        join(tempDir, "flows"),
        "--timeout",
        "2000",
        "--header",
        "x-unrelated: something-else",
      ],
      { cwd: tempDir },
    );

    expect(result.exitCode).toBe(0);
    // Guards against a green exit that never ran a flow at all.
    expect(result.stdout).toContain("1 flow: 1 passed, 0 failed");
    expect(result.stdout).not.toContain("from-config");
  });

  it("wins over the config for the same header name", async () => {
    tempDir = freshTempDir("cli-header-overrides");
    writeProject(
      `headers:
  x-flowspec-test: from-config
`,
      `name: cli-header-wins
description: the CLI value is the one that reaches the server
steps:
  - visit: /echo-header
expect:
  - visible: "Header: from-cli"
`,
    );

    const result = await runCLI(
      [
        "run",
        join(tempDir, "flows"),
        "--timeout",
        "2000",
        "--header",
        "x-flowspec-test: from-cli",
      ],
      { cwd: tempDir },
    );

    expect(result.exitCode).toBe(0);
    // Guards against a green exit that never ran a flow at all.
    expect(result.stdout).toContain("1 flow: 1 passed, 0 failed");
    expect(result.stdout).not.toContain("from-config");
  });

  it("accumulates two --header flags so both headers reach the server", async () => {
    tempDir = freshTempDir("cli-header-two-flags");
    // Two echo routes, one per header name: the flow only completes if BOTH
    // headers arrived, which a single accumulated map is the only way to do.
    writeProject(
      "",
      `name: cli-two-headers
description: both flags land
steps:
  - visit: /echo-header
  - wait_for: "Header: first"
  - visit: /echo-header-2
expect:
  - visible: "Header 2: second"
`,
    );

    const result = await runCLI(
      [
        "run",
        join(tempDir, "flows"),
        "--timeout",
        "2000",
        "--header",
        "x-flowspec-test: first",
        "--header",
        "x-flowspec-test-2: second",
      ],
      { cwd: tempDir },
    );

    expect(result.exitCode).toBe(0);
    // Guards against a green exit that never ran a flow at all.
    expect(result.stdout).toContain("1 flow: 1 passed, 0 failed");
  });

  it("lets the last flag win when the same header name is given twice", async () => {
    tempDir = freshTempDir("cli-header-duplicate");
    writeProject(
      "",
      `name: cli-duplicate-header
description: later duplicate wins
steps:
  - visit: /echo-header
expect:
  - visible: "Header: second"
`,
    );

    const result = await runCLI(
      [
        "run",
        join(tempDir, "flows"),
        "--timeout",
        "2000",
        "--header",
        "x-flowspec-test: first",
        "--header",
        "x-flowspec-test: second",
      ],
      { cwd: tempDir },
    );

    expect(result.exitCode).toBe(0);
    // Guards against a green exit that never ran a flow at all.
    expect(result.stdout).toContain("1 flow: 1 passed, 0 failed");
    expect(result.stdout).not.toContain("Header: first");
  });

  it("splits at the first colon only, so a value may contain colons", async () => {
    tempDir = freshTempDir("cli-header-colon-value");
    writeProject(
      "",
      `name: cli-header-colon-value
description: a value with colons survives intact
steps:
  - visit: /echo-header
expect:
  - visible: "Header: Bearer a:b:c"
`,
    );

    const result = await runCLI(
      [
        "run",
        join(tempDir, "flows"),
        "--timeout",
        "2000",
        "--header",
        "x-flowspec-test: Bearer a:b:c",
      ],
      { cwd: tempDir },
    );

    expect(result.exitCode).toBe(0);
    // Guards against a green exit that never ran a flow at all.
    expect(result.stdout).toContain("1 flow: 1 passed, 0 failed");
  });

  it("does not interpolate a variable reference in a CLI header value", async () => {
    tempDir = freshTempDir("cli-header-no-interpolation");
    // The shell already had its chance to expand this. A literal reference
    // that survives quoting is a literal value, not a lookup — substituting
    // it here would silently differ from what the user typed.
    writeProject(
      "",
      `name: cli-header-literal-dollar
description: the reference reaches the server verbatim
steps:
  - visit: /echo-header
expect:
  - visible: "Header: \${HOME}"
`,
    );

    const result = await runCLI(
      [
        "run",
        join(tempDir, "flows"),
        "--timeout",
        "2000",
        "--header",
        // Escaped in a template literal so the placeholder stays literal
        // without adding a noTemplateCurlyInString warning.
        `x-flowspec-test: \${HOME}`,
      ],
      { cwd: tempDir },
    );

    expect(result.exitCode).toBe(0);
    // Guards against a green exit that never ran a flow at all.
    expect(result.stdout).toContain("1 flow: 1 passed, 0 failed");
  });
});

/**
 * `headersScope` has to survive the config -> mergeConfig -> runFlows ->
 * runFlow trip, so these two tests differ in exactly one config line and must
 * disagree about what a second origin receives.
 */
describeIfAgentBrowser("CLI headersScope wiring", () => {
  let originA: TestServer;
  let originB: TestServer;

  beforeAll(async () => {
    originA = createTestServer();
    // A distinct port is a distinct origin; 3467 stays clear of the 3456
    // default and of runner-headers.test.ts's second origin.
    originB = createTestServer({ port: 3467 });
    await originA.start();
    await originB.start();
  });

  afterAll(async () => {
    await originA.stop();
    await originB.stop();
  });

  function writeCrossOriginProject(configBody: string): void {
    writeFileSync(
      join(tempDir, "flowspec.config.yaml"),
      `baseUrl: ${originA.baseUrl}
headers:
  x-flowspec-test: granted
${configBody}`,
    );
    writeFileSync(
      join(tempDir, "flows", "a-flow.flow.yaml"),
      `name: cross-origin-visit
description: navigates to an origin that is not baseUrl
steps:
  - visit: ${originB.baseUrl}/echo-header
expect:
  - visible: "${configBody ? "Header: granted" : "No header received"}"
`,
    );
  }

  it("withholds config headers from another origin by default", async () => {
    tempDir = freshTempDir("headers-scope-default");
    writeCrossOriginProject("");

    const result = await runCLI(
      ["run", join(tempDir, "flows"), "--timeout", "2000"],
      { cwd: tempDir },
    );

    expect(result.exitCode).toBe(0);
    // Guards against a green exit that never ran a flow at all.
    expect(result.stdout).toContain("1 flow: 1 passed, 0 failed");
  });

  it("sends config headers to another origin when headersScope is 'all'", async () => {
    tempDir = freshTempDir("headers-scope-all");
    writeCrossOriginProject("headersScope: all\n");

    const result = await runCLI(
      ["run", join(tempDir, "flows"), "--timeout", "2000"],
      { cwd: tempDir },
    );

    expect(result.exitCode).toBe(0);
    // Guards against a green exit that never ran a flow at all.
    expect(result.stdout).toContain("1 flow: 1 passed, 0 failed");
  });
});

describe("CLI --header malformed input", () => {
  // No browser is involved: every case here must be refused before anything
  // opens, which is the whole point of the "misconfigured, nothing ran"
  // contract.
  function writeMalformedProject(): void {
    writeFileSync(
      join(tempDir, "flowspec.config.yaml"),
      "baseUrl: http://localhost:3000\n",
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
  }

  it.each([
    ["no colon at all", "no-colon"],
    ["an empty header name", ": value-only"],
    ["a whitespace-only header name", "   : value-only"],
  ])("exits 2 for %s, before any flow runs", async (_label, headerArg) => {
    tempDir = freshTempDir("cli-header-malformed");
    writeMalformedProject();

    const result = await runCLI(
      ["run", join(tempDir, "flows"), "--header", headerArg],
      { cwd: tempDir },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).not.toContain("Unexpected error:");
    expect(result.stderr).toContain("--header");
    // One clean line, not a stack trace.
    expect(result.stderr.trim().split("\n").length).toBeLessThanOrEqual(2);
    expect(result.stdout).not.toContain("would-run");
    expect(result.stdout).not.toMatch(/\d+ flows?:/);
  });

  it("exits 2 when --header is given with no argument at all", async () => {
    tempDir = freshTempDir("cli-header-missing-operand");
    writeMalformedProject();

    const result = await runCLI(["run", join(tempDir, "flows"), "--header"], {
      cwd: tempDir,
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).not.toContain("Unexpected error:");
    expect(result.stderr).toContain("--header");
    expect(result.stdout).not.toMatch(/\d+ flows?:/);
  });

  it("reports a malformed --header even when a valid one is also supplied", async () => {
    tempDir = freshTempDir("cli-header-mixed");
    writeMalformedProject();

    const result = await runCLI(
      [
        "run",
        join(tempDir, "flows"),
        "--header",
        "x-flowspec-test: fine",
        "--header",
        "broken",
      ],
      { cwd: tempDir },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stdout).not.toMatch(/\d+ flows?:/);
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
