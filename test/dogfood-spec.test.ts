import { execSync } from "node:child_process";
import { delimiter, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCliFlow } from "../src/cli-runner";
import { parseFlowFile } from "../src/parser";

/**
 * Tests for WI-816: the dogfood spec — FlowSpec specs its own `flowspec
 * init` command as a protected, immutable `surface: cli` flow.
 *
 * AUTHORING NOTE (per the item's own context, human decision 2026-08-17):
 * this repo's PreToolUse hook blocks Edit/Write on any specs/**\/*.flow.yaml
 * path, so the spec content was drafted at spec-drafts/init.flow.yaml (not
 * the hook-protected path) and reviewed by a human before being moved into
 * place. The operator has since run `git mv spec-drafts/init.flow.yaml
 * specs/init.flow.yaml` — the draft location no longer exists, and this
 * file now points at the final, protected path.
 *
 * Test design: rather than asserting on the spec's internal YAML shape
 * (array-form run steps, exact assertion list, step count/order — testing
 * implementation detail, not behavior), this file does the two things the
 * item's own ACs actually call for:
 *  1. The literal last AC bullet: the shipped spec parses as a valid
 *     `surface: cli` FlowSpec, so a malformed spec fails `bun run test`
 *     and not only the e2e step.
 *  2. ACTUALLY RUNS the parsed spec via the real runCliFlow engine, twice
 *     in a row. This is a far stronger, more honest proof than static
 *     shape assertions: if the array-form run steps are wrong, if any of
 *     the three file assertions fail, if the second init's stdout doesn't
 *     say "Found existing config:", or if state leaks between runs, this
 *     test fails — for exactly the reason the AC cares about, not a proxy
 *     for it. It exercises the same execution path `flowspec run specs/`
 *     (WI-815's test:e2e) uses in production.
 *
 * `flowspec` must resolve on PATH for the spec's own run steps to spawn
 * it — this test builds+links it itself (mirroring WI-815's pretest:e2e
 * mechanism) rather than assuming the invoking process's PATH already has
 * node_modules/.bin, and temporarily prepends it to process.env.PATH so
 * runCliFlow's spawned children inherit it.
 */

const repoRoot = resolve(__dirname, "..");
const DOGFOOD_SPEC_PATH = join(repoRoot, "specs", "init.flow.yaml");

describe("specs/init.flow.yaml", () => {
  let originalPath: string | undefined;

  beforeAll(() => {
    execSync("bun run pretest:e2e", { cwd: repoRoot, stdio: "pipe" });

    const binDir = join(repoRoot, "node_modules", ".bin");
    originalPath = process.env.PATH;
    process.env.PATH = originalPath
      ? `${binDir}${delimiter}${originalPath}`
      : binDir;
  }, 60000);

  afterAll(() => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  });

  it("parses as a valid surface: cli FlowSpec", () => {
    const flow = parseFlowFile(DOGFOOD_SPEC_PATH);
    expect(flow.surface).toBe("cli");
  });

  it("passes when actually run via the real CLI engine, twice in a row with no leftover state between runs", async () => {
    const flow = parseFlowFile(DOGFOOD_SPEC_PATH);

    const first = await runCliFlow(flow, {});
    expect(first.success).toBe(true);

    const second = await runCliFlow(flow, {});
    expect(second.success).toBe(true);
  }, 30000);
});
