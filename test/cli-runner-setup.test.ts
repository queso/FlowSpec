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
import type { CliFlowSpec } from "../src/types";

/**
 * Tests for WI-811: the CLI runner's flow-level setup phase — a `surface:
 * cli` flow's own `setup` block of CLI steps, run before its steps, in the
 * same working directory, with PRD-0006 phase-labeled error reporting.
 *
 * Contract pinned by the work item:
 *  - Setup steps run in declaration order, in the SAME working directory
 *    as the flow's own steps (a file setup writes is visible to step 0).
 *  - A failing setup step fails the flow with `error.phase === "setup"`,
 *    `error.step` set to THAT STEP'S OWN INDEX within the setup array
 *    (local, 0-based — mirrors src/runner.ts's web setupIndex), and
 *    `error.stderr` carrying that step's stderr. None of the flow's own
 *    steps run afterward.
 *  - Setup steps follow the SAME exit-code contract as a NON-FINAL step —
 *    including the LAST setup step. Unlike the main steps phase (where the
 *    final step's bare exit code is never fatal), setup has no equivalent
 *    "last step" leniency: every setup step's exit code must match its
 *    expect_exit (default 0) or the setup phase fails, even for a
 *    single-step setup array.
 *  - Config-level (web) setup is never applied to a CLI flow. runCliFlow's
 *    options type (CliRunOptions) has no `setup` field at all — verified
 *    defensively by forwarding one anyway (bypassing the type system, as
 *    a future wiring bug plausibly could) and confirming it's ignored.
 *
 * Scope boundary (like WI-808's own tests): the "does not abort the run"
 * criterion describes EXISTING, unchanged logic in src/index.ts's
 * (unexported, not directly testable) runFlows — it aborts only when
 * `result.error?.phase === "setup" && flow.setup === undefined`. Since the
 * CLI dispatch item (wiring runCliFlow into runFlows) doesn't exist yet,
 * this can't be exercised end-to-end via the real CLI binary the way
 * test/cli-setup-abort.test.ts does for the web surface. Instead, this
 * file reconstructs that exact (unexported) condition inline against a
 * REAL runCliFlow result, proving the two are compatible: a CLI flow's own
 * setup failure always has `flow.setup !== undefined` (it only fails in
 * setup because it HAD one), so the existing abort condition already
 * evaluates to false for it — nothing here needs to change once dispatch
 * wires the two together.
 */

const execPath = process.execPath;
const ownedDirs: string[] = [];

function ownedTempDir(): string {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "flowspec-cli-runner-setup-")),
  );
  ownedDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of ownedDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function keepFailedWorkdir(result: { error?: { workdir?: string } }): string {
  const workdir = result.error?.workdir;
  expect(workdir).toBeDefined();
  ownedDirs.push(workdir as string);
  return workdir as string;
}

function cliFlow(
  steps: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): CliFlowSpec {
  return {
    name: "cli-flow",
    description: "A cli flow",
    surface: "cli",
    steps,
    expect: [],
    ...overrides,
  } as unknown as CliFlowSpec;
}

describe("setup runs before steps, sharing the same working directory", () => {
  it("runs setup steps before the flow's own steps, and a file setup writes is visible to step 0", async () => {
    const cwd = ownedTempDir();
    const flow = cliFlow(
      [
        {
          run: [
            execPath,
            "-e",
            "require('fs').writeFileSync('from-step.txt', require('fs').readFileSync('from-setup.txt','utf-8'))",
          ],
        },
      ],
      {
        setup: [
          {
            run: [
              execPath,
              "-e",
              "require('fs').writeFileSync('from-setup.txt', 'seeded-by-setup')",
            ],
          },
        ],
      },
    );

    const result = await runCliFlow(flow, { cwd });

    expect(result.success).toBe(true);
    expect(existsSync(join(cwd, "from-setup.txt"))).toBe(true);
    expect(readFileSync(join(cwd, "from-step.txt"), "utf-8")).toBe(
      "seeded-by-setup",
    );
  });
});

describe("a failing setup step fails the flow with phase: setup", () => {
  it("fails naming phase setup, the setup step's own index, and its stderr — and no flow step runs", async () => {
    const flow = cliFlow(
      [
        {
          run: [
            execPath,
            "-e",
            "require('fs').writeFileSync('should-not-exist.txt','x')",
          ],
        },
      ],
      {
        setup: [
          { run: [execPath, "-e", "process.exit(0)"] },
          {
            run: [
              execPath,
              "-e",
              "process.stderr.write('boom from setup step 1');process.exit(1)",
            ],
          },
        ],
      },
    );

    const result = await runCliFlow(flow, {});

    expect(result.success).toBe(false);
    expect(result.error?.phase).toBe("setup");
    expect(result.error?.step).toBe(1);
    expect(result.error?.stderr).toContain("boom from setup step 1");
    const workdir = keepFailedWorkdir(result);
    expect(existsSync(join(workdir, "should-not-exist.txt"))).toBe(false);
  });
});

describe("setup steps follow the same exit-code contract as non-final steps", () => {
  it("continues the setup chain when a setup step's exit code matches its expect_exit", async () => {
    const cwd = ownedTempDir();
    const flow = cliFlow(
      [
        {
          run: [
            execPath,
            "-e",
            "require('fs').writeFileSync('reached.txt','yes')",
          ],
        },
      ],
      {
        setup: [{ run: [execPath, "-e", "process.exit(1)"], expect_exit: 1 }],
      },
    );

    const result = await runCliFlow(flow, { cwd });

    expect(result.success).toBe(true);
    expect(existsSync(join(cwd, "reached.txt"))).toBe(true);
  });

  it("fails the setup phase when a setup step's exit code does not match its expect_exit", async () => {
    const flow = cliFlow([{ run: [execPath, "-e", "process.exit(0)"] }], {
      setup: [{ run: [execPath, "-e", "process.exit(2)"], expect_exit: 1 }],
    });

    const result = await runCliFlow(flow, {});

    expect(result.success).toBe(false);
    expect(result.error?.phase).toBe("setup");
    expect(result.error?.exitCode).toBe(2);
    keepFailedWorkdir(result);
  });

  it("has no 'final step' leniency: the LAST (and only) setup step still fails on a bare nonzero exit with no expect_exit", async () => {
    // Unlike the main steps phase, where a lone/final step's bare exit code
    // is never fatal by itself, setup has no assertion phase of its own —
    // every setup step, including the last one in the array, is always
    // "non-final" for exit-code purposes.
    const flow = cliFlow([{ run: [execPath, "-e", "process.exit(0)"] }], {
      setup: [{ run: [execPath, "-e", "process.exit(1)"] }],
    });

    const result = await runCliFlow(flow, {});

    expect(result.success).toBe(false);
    expect(result.error?.phase).toBe("setup");
    expect(result.error?.step).toBe(0);
    keepFailedWorkdir(result);
  });
});

describe("config-level (web) setup is never applied to a CLI flow", () => {
  it("ignores a web setup option entirely, even if present on the options object", async () => {
    const cwd = ownedTempDir();
    const flow = cliFlow([{ run: [execPath, "-e", "process.exit(0)"] }]);
    // CliRunOptions has no `setup` field — cast past the type system to
    // prove runCliFlow never reads a stray one, defending against a future
    // dispatch-wiring mistake that forwards the config's web setup here.
    const optionsWithWebSetup = {
      cwd,
      setup: [{ visit: "/should-never-be-touched" }],
    } as unknown as Parameters<typeof runCliFlow>[1];

    const result = await runCliFlow(flow, optionsWithWebSetup);

    expect(result.success).toBe(true);
  });
});

describe("compatibility with index.ts's existing (unchanged) abort condition", () => {
  it("a CLI flow's own setup failure always has flow.setup defined, so the existing abort-only-on-config-setup condition already evaluates to false for it", async () => {
    const flow = cliFlow([{ run: [execPath, "-e", "process.exit(0)"] }], {
      setup: [{ run: [execPath, "-e", "process.exit(1)"] }],
    });

    const result = await runCliFlow(flow, {});

    expect(result.success).toBe(false);
    expect(result.error?.phase).toBe("setup");
    keepFailedWorkdir(result);

    // Mirrors src/index.ts's runFlows abort condition verbatim (not
    // exported, so reconstructed here) — see file header for why.
    const wouldAbortAsConfigSetupFailure =
      result.error?.phase === "setup" && flow.setup === undefined;
    expect(wouldAbortAsConfigSetupFailure).toBe(false);
  });
});
