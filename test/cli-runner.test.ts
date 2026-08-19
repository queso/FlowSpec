import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCliFlow } from "../src/cli-runner";
import type { FlowSpec } from "../src/types";

/**
 * Tests for WI-808: the CLI execution core — runs a `surface: cli` flow's
 * `run` steps in declaration order inside the flow's working directory,
 * applying the PRD's fail-fast exit-code contract.
 *
 * Contract pinned by the work item:
 *  - runCliFlow(flow: FlowSpec, options?): Promise<FlowResult>, options
 *    carrying { cwd?, timeout?, captureLimit? } (the merged config shape).
 *  - Phases in order: create workdir (src/workdir.ts) -> setup (present,
 *    no-op until a later item fills it in) -> steps (this item) ->
 *    assertion hook (a later item plugs in; every fixture here uses
 *    `expect: []` so this item's tests never depend on that wiring) ->
 *    dispose workdir keyed on pass/fail.
 *  - On step failure, `error` carries the CLI FlowError fields from
 *    WI-805: `step` (index), `action` (the failing CliStep), `exitCode`,
 *    `stdout`, `stderr`, `workdir`.
 *
 * Observability strategy (deliberate, see below): a PASSED flow's workdir
 * is deleted (WI-804 dispose-on-pass), so pass-path tests that need to
 * inspect a step's side effects (order, env, stdin, argv fidelity) pass an
 * explicit `options.cwd` pointing at a test-owned temp dir, which
 * createFlowWorkdir treats as "configured" and never deletes. Fail-path
 * tests instead let runCliFlow create its own temp workdir and inspect it
 * via `result.error.workdir` (which also doubles as a proof that failure
 * keeps the directory and reports its path) — cleaned up manually in
 * `afterEach` since a kept directory is not this suite's to leave behind.
 *
 * Every fixture uses `expect: []` (parses today per WI-805 — CLI flows
 * with zero assertions have nothing to evaluate) so these tests exercise
 * ONLY the steps phase this item implements, independent of whichever
 * item wires the assertion-evaluation hook.
 */

const execPath = process.execPath;

const ownedDirs: string[] = [];

function ownedTempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "flowspec-cli-runner-")));
  ownedDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of ownedDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Track a fail-path result's kept workdir for cleanup, and return it. */
function keepFailedWorkdir(result: { error?: { workdir?: string } }): string {
  const workdir = result.error?.workdir;
  expect(workdir).toBeDefined();
  ownedDirs.push(workdir as string);
  return workdir as string;
}

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

describe("step execution: order, env, stdin, argv fidelity", () => {
  it("executes run steps in declaration order, inside the flow's working directory", async () => {
    const cwd = ownedTempDir();
    const append = (label: string) =>
      `${execPath} -e require('fs').appendFileSync('order.log','${label}\\n')`;
    const flow = cliFlow([
      { run: append("step0") },
      { run: append("step1") },
      { run: append("step2") },
    ]);

    const result = await runCliFlow(flow, { cwd });

    expect(result.success).toBe(true);
    const content = readFileSync(join(cwd, "order.log"), "utf-8");
    expect(content).toBe("step0\nstep1\nstep2\n");
  });

  it("applies each step's own env overlay, without leaking it to a sibling step", async () => {
    const cwd = ownedTempDir();
    const envScript =
      "require('fs').appendFileSync('env.log',(process.env.MARKER||'ABSENT')+'\\n')";
    const flow = cliFlow([
      { run: [execPath, "-e", envScript], env: { MARKER: "hello" } },
      { run: [execPath, "-e", envScript] },
    ]);

    const result = await runCliFlow(flow, { cwd });

    expect(result.success).toBe(true);
    const content = readFileSync(join(cwd, "env.log"), "utf-8");
    expect(content).toBe("hello\nABSENT\n");
  });

  it("writes each step's own stdin to the child and closes the stream", async () => {
    const cwd = ownedTempDir();
    const stdinScript =
      "let d='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{d+=c});process.stdin.on('end',()=>{require('fs').writeFileSync('stdin.log',d)})";
    const flow = cliFlow([
      { run: [execPath, "-e", stdinScript], stdin: "stdin-content" },
    ]);

    const result = await runCliFlow(flow, { cwd });

    expect(result.success).toBe(true);
    const content = readFileSync(join(cwd, "stdin.log"), "utf-8");
    expect(content).toBe("stdin-content");
  });

  it("passes an array-form element containing a space through untouched, as one argv entry", async () => {
    const cwd = ownedTempDir();
    const flow = cliFlow([
      {
        run: [
          execPath,
          "-e",
          "require('fs').writeFileSync('arrayform.log', process.argv.at(-1))",
          "two words",
        ],
      },
    ]);

    const result = await runCliFlow(flow, { cwd });

    expect(result.success).toBe(true);
    const content = readFileSync(join(cwd, "arrayform.log"), "utf-8");
    expect(content).toBe("two words");
  });

  it("splits string-form run on whitespace only, passing shell metacharacters through literally", async () => {
    const cwd = ownedTempDir();
    const flow = cliFlow([
      {
        run: `${execPath} -e require('fs').writeFileSync('metachar.log','a&&b')`,
      },
    ]);

    const result = await runCliFlow(flow, { cwd });

    expect(result.success).toBe(true);
    const content = readFileSync(join(cwd, "metachar.log"), "utf-8");
    expect(content).toBe("a&&b");
  });

  it("does not shell-parse a quoted substring in string form back into one argv element", async () => {
    // A naive whitespace split of `-e "process.exit(process.argv.length)" "two words"`
    // yields 5 tokens with the quote characters embedded literally, which
    // makes the -e argument a syntactically valid but INERT string-literal
    // statement (verified interactively) — so the step exits 0 naturally.
    // A shell-aware parser would instead strip the quotes and produce a
    // working script + one reassembled "two words" argument, exiting with
    // some other (nonzero) code from process.argv.length. Asserting the
    // flow PASSES (expect_exit: 0 matched) pins the naive-split behavior.
    const cwd = ownedTempDir();
    const flow = cliFlow([
      {
        run: `${execPath} -e "process.exit(process.argv.length)" "two words"`,
        expect_exit: 0,
      },
      { run: [execPath, "-e", "process.exit(0)"] },
    ]);

    const result = await runCliFlow(flow, { cwd });

    expect(result.success).toBe(true);
  });

  it("is a no-op for a cli flow's setup block (present but not executed by this item)", async () => {
    const cwd = ownedTempDir();
    const flow = cliFlow([{ run: [execPath, "-e", "process.exit(0)"] }], {
      setup: [{ run: [execPath, "-e", "process.exit(0)"] }],
    });

    const result = await runCliFlow(flow, { cwd });

    expect(result.success).toBe(true);
  });
});

describe("fail-fast: non-final step, no expect_exit", () => {
  it("fails the flow at that step index, carrying the step's stderr, and never runs later steps", async () => {
    const flow = cliFlow([
      {
        run: [
          execPath,
          "-e",
          "process.stderr.write('boom from step0');process.exit(1)",
        ],
      },
      {
        run: [
          execPath,
          "-e",
          "require('fs').writeFileSync('should-not-exist.txt','x')",
        ],
      },
    ]);

    const result = await runCliFlow(flow, {});

    expect(result.success).toBe(false);
    expect(result.error?.step).toBe(0);
    expect(result.error?.stderr).toContain("boom from step0");
    const workdir = keepFailedWorkdir(result);
    expect(existsSync(join(workdir, "should-not-exist.txt"))).toBe(false);
  });
});

describe("fail-fast: non-final step with expect_exit", () => {
  it("continues the chain when the exit code matches expect_exit", async () => {
    const cwd = ownedTempDir();
    const flow = cliFlow([
      { run: [execPath, "-e", "process.exit(1)"], expect_exit: 1 },
      {
        run: [
          execPath,
          "-e",
          "require('fs').writeFileSync('reached.txt','yes')",
        ],
      },
    ]);

    const result = await runCliFlow(flow, { cwd });

    expect(result.success).toBe(true);
    expect(existsSync(join(cwd, "reached.txt"))).toBe(true);
  });

  it("fails the flow at that step when the exit code does not match expect_exit", async () => {
    const flow = cliFlow([
      { run: [execPath, "-e", "process.exit(2)"], expect_exit: 1 },
      {
        run: [
          execPath,
          "-e",
          "require('fs').writeFileSync('should-not-exist.txt','x')",
        ],
      },
    ]);

    const result = await runCliFlow(flow, {});

    expect(result.success).toBe(false);
    expect(result.error?.step).toBe(0);
    expect(result.error?.exitCode).toBe(2);
    const workdir = keepFailedWorkdir(result);
    expect(existsSync(join(workdir, "should-not-exist.txt"))).toBe(false);
  });
});

describe("final step: bare exit code never fails the flow", () => {
  it("completes the step phase successfully when the last step exits nonzero and declares no expect_exit", async () => {
    const flow = cliFlow([{ run: [execPath, "-e", "process.exit(1)"] }]);

    const result = await runCliFlow(flow, {});

    expect(result.success).toBe(true);
  });
});

describe("final step: expect_exit applies uniformly", () => {
  it("proceeds to assertions when the final step's exit code matches its expect_exit", async () => {
    const flow = cliFlow([
      { run: [execPath, "-e", "process.exit(1)"], expect_exit: 1 },
    ]);

    const result = await runCliFlow(flow, {});

    expect(result.success).toBe(true);
  });

  it("fails the flow at the final step when its exit code does not match its expect_exit", async () => {
    const flow = cliFlow([
      { run: [execPath, "-e", "process.exit(0)"], expect_exit: 1 },
    ]);

    const result = await runCliFlow(flow, {});

    expect(result.success).toBe(false);
    expect(result.error?.step).toBe(0);
    expect(result.error?.exitCode).toBe(0);
    keepFailedWorkdir(result);
  });
});

describe("timeout and spawn failure stop the flow before assertions", () => {
  it("fails the flow as a timeout at the step that exceeded it, and never runs a later step", async () => {
    const flow = cliFlow([
      { run: [execPath, "-e", "setTimeout(()=>{},10000)"], timeout: 300 },
      {
        run: [
          execPath,
          "-e",
          "require('fs').writeFileSync('should-not-exist.txt','x')",
        ],
      },
    ]);

    const result = await runCliFlow(flow, {});

    expect(result.success).toBe(false);
    expect(result.error?.step).toBe(0);
    expect(result.error?.message.toLowerCase()).toContain("timed out");
    const workdir = keepFailedWorkdir(result);
    expect(existsSync(join(workdir, "should-not-exist.txt"))).toBe(false);
  });

  it("honors options.timeout as the fallback when a step declares no timeout of its own", async () => {
    const flow = cliFlow([
      { run: [execPath, "-e", "setTimeout(()=>{},10000)"] },
    ]);

    const result = await runCliFlow(flow, { timeout: 300 });

    expect(result.success).toBe(false);
    expect(result.error?.message.toLowerCase()).toContain("timed out");
    keepFailedWorkdir(result);
  });

  it("fails the flow with an error naming the command when it cannot be spawned, and never runs a later step", async () => {
    const missingCommand = "flowspec-definitely-not-a-real-binary-xyz";
    const flow = cliFlow([
      { run: [missingCommand] },
      {
        run: [
          execPath,
          "-e",
          "require('fs').writeFileSync('should-not-exist.txt','x')",
        ],
      },
    ]);

    const result = await runCliFlow(flow, {});

    expect(result.success).toBe(false);
    expect(result.error?.step).toBe(0);
    expect(result.error?.message).toContain(missingCommand);
    const workdir = keepFailedWorkdir(result);
    expect(existsSync(join(workdir, "should-not-exist.txt"))).toBe(false);
  });
});
