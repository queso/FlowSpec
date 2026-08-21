import { execSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { CONFIG_FILE_NAME, loadConfigFile } from "../src/config";

/**
 * Tests for WI-815: the plumbing that makes the (separately-landed, WI-816)
 * dogfood spec runnable — a root flowspec.config.yaml, a `test:e2e`/
 * `pretest:e2e` script pair in package.json, and a CI step.
 *
 * This is a `type: task` scaffolding item: per the tdd-workflow skill, that
 * means smoke tests proving the toolchain actually works end-to-end, not
 * file-existence checks (banned anti-pattern #10 — a script or config file
 * can exist on disk and still be completely unwired). Every test below
 * either parses real config/CI YAML through the project's own real parsing
 * code, or actually RUNS the real build+link mechanism and invokes the
 * resulting binary against a throwaway fixture spec.
 *
 * Deliberately NOT tested here: running the real `specs/` directory itself
 * — that content is WI-816's job, a separate, undependent item, and doesn't
 * exist yet. This file proves the MECHANISM (build, link, explicit-path
 * invocation) works against a test-owned fixture spec instead, so it never
 * depends on WI-816 landing first.
 *
 * AC "adding a root flowspec.config.yaml does not change any existing
 * test's behavior" is verified by running the full `bun run test` suite
 * (not re-tested here as a meta-test) — every existing config fixture
 * builds under os.tmpdir(), a sibling branch of the filesystem tree that
 * findConfigFile's walk-up can never reach the repo root through.
 */

const repoRoot = resolve(__dirname, "..");
const execPath = process.execPath;

describe("root flowspec.config.yaml", () => {
  it("exists and declares specsDir: 'specs/', parsed through the real config loader", () => {
    const configPath = join(repoRoot, CONFIG_FILE_NAME);
    const config = loadConfigFile(configPath);

    expect(config.specsDir).toBe("specs/");
  });
});

describe("package.json: test:e2e / pretest:e2e scripts", () => {
  const packageJson = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf-8"),
  ) as { scripts?: Record<string, string> };
  const scripts = packageJson.scripts ?? {};

  it("test:e2e passes an explicit 'specs/' path rather than relying on discovery", () => {
    // Pinned per the item's own literal wording — flowspec run intentionally
    // has no specsDir-based discovery (out of scope by human decision), so
    // the script must name the path itself.
    expect(scripts["test:e2e"]).toBe("flowspec run specs/");
  });

  it("pretest:e2e is present and its command builds the project and links node_modules/.bin/flowspec to dist/index.js", () => {
    expect(scripts["pretest:e2e"]).toBeDefined();
    const command = scripts["pretest:e2e"] as string;
    expect(command).toContain("dist/index.js");
    expect(command).toMatch(/\.bin\/flowspec/);
  });
});

describe("pretest:e2e actually builds and links a working 'flowspec' binary", () => {
  it("running pretest:e2e twice in a row produces a working node_modules/.bin/flowspec both times", () => {
    // Real toolchain proof, not a file-existence check: actually run the
    // real script, then actually invoke the linked binary against a
    // throwaway fixture spec (not the real specs/ — that's WI-816's,
    // separately-landed content) and confirm it genuinely executes.
    const fixtureDir = realpathSync(
      mkdtempSync(join(tmpdir(), "flowspec-dogfood-plumbing-")),
    );
    const binPath = join(repoRoot, "node_modules", ".bin", "flowspec");

    try {
      writeFileSync(
        join(fixtureDir, "smoke.flow.yaml"),
        `name: plumbing-smoke-test
description: proves the linked flowspec binary actually runs a cli spec
surface: cli
steps:
  - run: "${execPath} -e process.exit(0)"
expect:
  - exit_code: 0
`,
      );

      for (let attempt = 1; attempt <= 2; attempt++) {
        execSync("bun run pretest:e2e", {
          cwd: repoRoot,
          stdio: "pipe",
          timeout: 45000,
        });

        expect(existsSync(join(repoRoot, "dist", "index.js"))).toBe(true);
        expect(existsSync(binPath)).toBe(true);

        const output = execSync(`"${binPath}" run "${fixtureDir}"`, {
          cwd: repoRoot,
          encoding: "utf-8",
          timeout: 15000,
        });
        expect(output).toContain("plumbing-smoke-test");
        expect(output).toContain("1 flow");
      }
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  }, 60000);
});

describe("CI workflow: build before, and run, the dogfood e2e step", () => {
  it("builds the project and runs test:e2e as its own step after the unit tests", () => {
    const workflowPath = join(repoRoot, ".github", "workflows", "ci.yml");
    const workflow = yaml.load(readFileSync(workflowPath, "utf-8")) as {
      jobs: {
        test: { steps: Array<{ name?: string; run?: string }> };
      };
    };
    const steps = workflow.jobs.test.steps;
    const stepNames = steps.map((step) => step.run ?? "");

    const buildIndex = stepNames.findIndex((run) => /\bbuild\b/.test(run));
    const unitTestIndex = stepNames.findIndex(
      (run) => /\btest\b/.test(run) && !/e2e/.test(run),
    );
    const e2eIndex = stepNames.findIndex((run) => /test:e2e/.test(run));

    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(unitTestIndex).toBeGreaterThanOrEqual(0);
    expect(e2eIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeLessThan(e2eIndex);
    expect(unitTestIndex).toBeLessThan(e2eIndex);
  });
});
