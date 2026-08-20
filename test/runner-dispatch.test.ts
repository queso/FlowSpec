import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateCliAssertion } from "../src/cli-assertions";
import { runFlow } from "../src/runner";
import type { CliAssertion, FlowSpec } from "../src/types";
import { hasBrowserBinaries } from "./helpers/has-browser";

/**
 * Tests for WI-812: runFlow's top-level surface dispatch, and defensive
 * guards in evaluateCliAssertion flagged by Amy's WI-809 probing.
 *
 * Contract pinned by the work item:
 *  - runFlow branches on `flow.surface` as the FIRST thing it does — before
 *    generateSessionName, before the headers block, before any browser
 *    session exists — routing `surface: "cli"` to runCliFlow and leaving
 *    the web path (absent surface, or "web") untouched.
 *  - A CLI flow's FlowResult carries flowName/duration/success and, on
 *    failure, the CLI FlowError shape, with assertions (evaluateCliAssertion,
 *    called once per flow.expect entry, in order, stopping at the first
 *    failure) evaluated only after all steps pass.
 *  - Web regression: test/runner.test.ts, test/runner-setup.test.ts,
 *    test/runner-retry.test.ts, test/runner-headers.test.ts pass
 *    unmodified (verified by running them, not re-tested here).
 *
 * Scope boundary on "never resolves/launches agent-browser": actually
 * deleting or renaming the real agent-browser binary to simulate
 * unresolvability would be an invasive, cross-test-unsafe filesystem
 * mutation (other concurrently-running test files need a working
 * agent-browser). Instead this file proves the AC's OBSERVABLE consequence:
 * a CLI flow given options that would immediately blow up the web path if
 * reached (an unparseable baseUrl, headers configured with the
 * browser-issuing "all" scope) still completes cleanly and fast — which is
 * only possible if dispatch truly short-circuits before any of that code
 * runs. See test/helpers/has-browser.ts's own comment: spawning agent-browser
 * when its binaries are missing HANGS rather than failing fast, which is
 * exactly the failure mode a wrong dispatch order would risk here.
 */

const execPath = process.execPath;
const ownedDirs: string[] = [];

function ownedTempDir(): string {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "flowspec-runner-dispatch-")),
  );
  ownedDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of ownedDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function cliFlow(
  steps: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): FlowSpec {
  return {
    name: "cli-flow",
    description: "A cli flow",
    surface: "cli",
    steps,
    expect: [],
    ...overrides,
  } as unknown as FlowSpec;
}

describe("runFlow: surface: cli returns a FlowResult via the CLI runner", () => {
  it("returns success with flowName and duration for a passing cli flow", async () => {
    const flow = cliFlow([{ run: [execPath, "-e", "process.exit(0)"] }]);

    const result = await runFlow(flow, { timeout: 5000 });

    expect(result.success).toBe(true);
    expect(result.flowName).toBe("cli-flow");
    expect(typeof result.duration).toBe("number");
  });

  it("returns the CLI FlowError shape (step, exitCode, stdout, stderr, workdir) for a failing step", async () => {
    // A NON-final step (a second step follows) so its bare nonzero exit is
    // genuinely fatal — per WI-808's own exit-code contract (also pinned by
    // this file's own test/cli-runner.test.ts), a lone/final step's bare
    // exit code is never fatal by itself. Using a single-step flow here
    // would contradict that already-approved contract (caught by ba's
    // TEST BUG rejection — thank you).
    const flow = cliFlow([
      {
        run: [execPath, "-e", "process.stderr.write('boom');process.exit(1)"],
      },
      { run: [execPath, "-e", "process.exit(0)"] },
    ]);

    const result = await runFlow(flow, { timeout: 5000 });

    expect(result.success).toBe(false);
    expect(result.error?.step).toBe(0);
    expect(result.error?.exitCode).toBe(1);
    expect(result.error?.stderr).toContain("boom");
    expect(result.error?.workdir).toBeDefined();
    if (result.error?.workdir) {
      ownedDirs.push(result.error.workdir);
    }
  });

  it("evaluates assertions only after all steps pass, reporting the assertion's own failure", async () => {
    const flow = cliFlow([{ run: [execPath, "-e", "process.exit(0)"] }], {
      expect: [{ exit_code: 1 }],
    });

    const result = await runFlow(flow, { timeout: 5000 });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("1");
    expect(result.error?.message).toContain("0");
    if (result.error?.workdir) {
      ownedDirs.push(result.error.workdir);
    }
  });

  it("passes when the flow's steps and its assertions both succeed", async () => {
    const flow = cliFlow([{ run: [execPath, "-e", "process.exit(0)"] }], {
      expect: [{ exit_code: 0 }],
    });

    const result = await runFlow(flow, { timeout: 5000 });

    expect(result.success).toBe(true);
  });
});

describe("runFlow: CLI dispatch happens before any browser/header work", () => {
  it("completes a cli flow cleanly even with an unparseable baseUrl and headers configured with the browser-issuing scope", async () => {
    const flow = cliFlow([{ run: [execPath, "-e", "process.exit(0)"] }]);

    const start = Date.now();
    const result = await runFlow(flow, {
      baseUrl: "not a valid url at all",
      headers: { Authorization: "Bearer fake-token" },
      headersScope: "all",
      timeout: 5000,
    });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    // A generous but real bound: dispatching correctly means this never
    // touches header validation, URL parsing, or a browser session — all
    // of which this input is specifically crafted to blow up if reached.
    expect(elapsed).toBeLessThan(3000);
  });

  it("never produces a headers-phase error for a cli flow, even when headers are configured", async () => {
    const flow = cliFlow([{ run: [execPath, "-e", "process.exit(0)"] }]);

    const result = await runFlow(flow, {
      headers: { "X-Test": "value" },
      timeout: 5000,
    });

    expect(result.success).toBe(true);
    expect(result.error?.phase).not.toBe("headers");
  });
});

describe("runFlow: CLI options threading (cwd, stepTimeout, captureLimit)", () => {
  it("forwards options.cwd to the CLI runner as the flow's working directory", async () => {
    const cwd = ownedTempDir();
    const flow = cliFlow([
      {
        run: [
          execPath,
          "-e",
          "require('fs').writeFileSync('marker.txt','from-dispatch')",
        ],
      },
    ]);

    const result = await runFlow(flow, { cwd, timeout: 5000 });

    expect(result.success).toBe(true);
    expect(readFileSync(join(cwd, "marker.txt"), "utf-8")).toBe(
      "from-dispatch",
    );
  });

  it("forwards options.stepTimeout to the CLI runner as the step timeout fallback", async () => {
    // Re-pointed at `stepTimeout` by the post-mission sweep (fix M2): the
    // process-kill deadline is its own key, distinct from the
    // assertion-retry budget that `timeout` carries. Threading is what this
    // asserts, and it still asserts it.
    const flow = cliFlow([
      { run: [execPath, "-e", "setTimeout(()=>{},10000)"] },
    ]);

    const start = Date.now();
    const result = await runFlow(flow, { stepTimeout: 300 });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    expect(result.error?.message.toLowerCase()).toContain("timed out");
    expect(elapsed).toBeLessThan(3000);
    if (result.error?.workdir) {
      ownedDirs.push(result.error.workdir);
    }
  });
});

describe("evaluateCliAssertion: defensive guards (Amy's WI-809 probing findings)", () => {
  // Each fixture bypasses FlowSpecSchema's own validation (the superRefine
  // that normally guarantees these keys are present) via an explicit cast,
  // simulating a caller that reaches this function directly — exactly what
  // this item's dispatch wiring does. All 4 cases below were verified
  // interactively to either throw or silently produce a false-positive PASS
  // against the current implementation before being written as tests.

  it("does not throw on json_output with a missing path against valid JSON stdout", async () => {
    const assertion = { json_output: { equals: 2 } } as unknown as CliAssertion;
    const lastStep = { stdout: '{"a":{"b":2}}', stderr: "", exitCode: 0 };

    await expect(
      evaluateCliAssertion(assertion, lastStep, "/tmp", 0),
    ).resolves.toBeDefined();
  });

  it("does not throw on file_contains with a missing path", async () => {
    const assertion = {
      file_contains: { text: "x" },
    } as unknown as CliAssertion;
    const lastStep = { stdout: "", stderr: "", exitCode: 0 };

    await expect(
      evaluateCliAssertion(assertion, lastStep, "/tmp", 0),
    ).resolves.toBeDefined();
  });

  it("does not silently pass on file_contains with a missing text, even when the file content happens to contain the literal word 'undefined'", async () => {
    // Regression guard for a real false-positive risk: `content.includes(undefined)`
    // coerces to `content.includes("undefined")`. A file whose content
    // genuinely contains that word would make an unguarded implementation
    // report a PASS for an assertion that never specified real text to look
    // for — verified interactively against the current implementation.
    const dir = ownedTempDir();
    const filePath = join(dir, "content.txt");
    writeFileSync(filePath, "some undefined behavior here");
    const assertion = {
      file_contains: { path: filePath },
    } as unknown as CliAssertion;
    const lastStep = { stdout: "", stderr: "", exitCode: 0 };

    const result = await evaluateCliAssertion(assertion, lastStep, dir, 0);

    expect(result).toBeDefined();
  });

  it("does not throw on an assertion shape matching none of the 8 CLI verbs", async () => {
    const assertion = { bogus_verb: "x" } as unknown as CliAssertion;
    const lastStep = { stdout: "", stderr: "", exitCode: 0 };

    await expect(
      evaluateCliAssertion(assertion, lastStep, "/tmp", 0),
    ).resolves.toBeDefined();
  });
});

const CLI_PATH = join(__dirname, "..", "src", "index.ts");

async function runCLI(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn("bun", ["run", CLI_PATH, ...args], {
      cwd,
      timeout: 15000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) =>
      resolve({ stdout, stderr, exitCode: code ?? 1 }),
    );
    child.on("error", (err) => {
      stderr += err.message;
      resolve({ stdout, stderr, exitCode: 1 });
    });
  });
}

const describeIfAgentBrowser = hasBrowserBinaries() ? describe : describe.skip;

describeIfAgentBrowser(
  "flowspec run: a mixed directory executes both surfaces in one summary",
  () => {
    it("runs a web flow and a cli flow together, printing one summary and exiting 1 when the web flow fails", async () => {
      // IMPORTANT: this asserts on an OBSERVABLE SIDE EFFECT (a file the CLI
      // step writes into a configured, inspectable cwd), not just the
      // reported pass/fail outcome. Verified interactively: src/runner.ts's
      // executeStep/checkAssertion both silently no-op (no final else
      // branch) on a step/assertion shape they don't recognize — so an
      // UNWIRED web path would still report a `run`-only, `expect: []`
      // CLI flow as a trivial "pass" without ever having executed anything,
      // making a pass/fail-only assertion here a false-positive risk that
      // can't distinguish "dispatch works" from "dispatch doesn't exist and
      // the step was silently skipped."
      const projectDir = ownedTempDir();
      mkdirSync(join(projectDir, "flows"), { recursive: true });
      mkdirSync(join(projectDir, "sandbox"), { recursive: true });
      writeFileSync(
        join(projectDir, "flowspec.config.yaml"),
        "cwd: ./sandbox\n",
      );
      writeFileSync(
        join(projectDir, "flows", "web-flow.flow.yaml"),
        `name: web-flow
description: fails fast against an unreachable port, never needs a real server
steps:
  - visit: http://localhost:1/
expect:
  - visible: Unreachable
`,
      );
      writeFileSync(
        join(projectDir, "flows", "cli-flow.flow.yaml"),
        `name: cli-flow
description: a cli flow that proves it really ran via a file it writes
surface: cli
steps:
  - run: "${execPath} -e require('fs').writeFileSync('really-ran.txt','yes')"
expect:
  - exit_code: 0
`,
      );

      const result = await runCLI(
        ["run", join(projectDir, "flows"), "--timeout", "2000"],
        projectDir,
      );

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("web-flow");
      expect(result.stdout).toContain("cli-flow");
      expect(result.stdout).toContain("2 flows: 1 passed, 1 failed");
      expect(
        readFileSync(join(projectDir, "sandbox", "really-ran.txt"), "utf-8"),
      ).toBe("yes");
    }, 20000);
  },
);
