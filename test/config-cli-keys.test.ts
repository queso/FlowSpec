/**
 * Tests for WI-807: the `cwd` and `captureLimit` config keys the CLI
 * surface needs, threaded through mergeConfig (which rebuilds its result
 * field by field and would otherwise silently drop them), plus a
 * regression pin that config-level `setup` stays web-only.
 *
 * Contract pinned by the work item:
 *  - cwd: z.string().optional() on FlowSpecConfigSchema — no schema-level
 *    resolution against process.cwd() (that's the workdir module's job).
 *  - captureLimit: a positive integer (bytes), optional, NO schema-level
 *    default — stays undefined when absent (mirrors `setup`'s existing
 *    optional-with-no-default pattern). DEFAULT_CAPTURE_LIMIT is applied
 *    downstream by the exec/CLI-runner consumer, not by config loading.
 *  - mergeConfig must carry both through untouched when CLI options
 *    declare neither (cliOptions has no cwd/captureLimit fields per this
 *    item's scope — mirrors setup's config-only, never-CLI-overridable
 *    pattern; adding CLI overrides for these is not in this AC).
 *  - A config declaring neither key loads exactly as today (both fields
 *    undefined), and the existing config test suites are unaffected.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  loadConfig,
  loadConfigFile,
  mergeConfig,
} from "../src/config";
import { DEFAULT_CAPTURE_LIMIT } from "../src/exec";

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `flowspec-config-cli-keys-test-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function writeConfig(contents: string): string {
  const configPath = join(tempDir, CONFIG_FILE_NAME);
  writeFileSync(configPath, contents);
  return configPath;
}

describe("FlowSpecConfigSchema / loadConfigFile: cwd and captureLimit", () => {
  it("loads cwd and captureLimit together when both are declared", () => {
    const configPath = writeConfig("cwd: ./sandbox\ncaptureLimit: 1048576\n");

    const config = loadConfigFile(configPath);

    expect(config.cwd).toBe("./sandbox");
    expect(config.captureLimit).toBe(1048576);
  });

  it("leaves cwd and captureLimit undefined, and other fields at their defaults, when neither key is declared", () => {
    const configPath = writeConfig("baseUrl: http://custom.com\n");

    const config = loadConfigFile(configPath);

    expect(config.cwd).toBeUndefined();
    expect(config.captureLimit).toBeUndefined();
    expect(config.baseUrl).toBe("http://custom.com");
    expect(config.timeout).toBe(DEFAULT_CONFIG.timeout);
    expect(config.specsDir).toBe(DEFAULT_CONFIG.specsDir);
  });

  it("substitutes a ${VAR} reference in cwd before validation", () => {
    const original = process.env.FLOWSPEC_TEST_SANDBOX_DIR;
    process.env.FLOWSPEC_TEST_SANDBOX_DIR = "./from-env-sandbox";
    try {
      const configPath = writeConfig("cwd: ${FLOWSPEC_TEST_SANDBOX_DIR}\n");

      const config = loadConfigFile(configPath);

      expect(config.cwd).toBe("./from-env-sandbox");
    } finally {
      if (original === undefined) {
        delete process.env.FLOWSPEC_TEST_SANDBOX_DIR;
      } else {
        process.env.FLOWSPEC_TEST_SANDBOX_DIR = original;
      }
    }
  });
});

describe("captureLimit validation", () => {
  it.each([
    ["zero", 0],
    ["negative", -1024],
  ])("rejects a %s captureLimit, naming the field", (_label, value) => {
    const configPath = writeConfig(`captureLimit: ${value}\n`);

    expect(() => loadConfigFile(configPath)).toThrow(/invalid configuration/i);
    try {
      loadConfigFile(configPath);
      throw new Error("expected loadConfigFile to throw");
    } catch (error) {
      expect((error as Error).message).toContain("captureLimit");
    }
  });

  it("rejects a non-numeric captureLimit, naming the field", () => {
    const configPath = writeConfig('captureLimit: "not-a-number"\n');

    try {
      loadConfigFile(configPath);
      throw new Error("expected loadConfigFile to throw");
    } catch (error) {
      expect((error as Error).message).toContain("captureLimit");
    }
  });
});

describe("cwd type validation", () => {
  it("rejects a non-string cwd, naming the field", () => {
    const configPath = writeConfig("cwd: 12345\n");

    try {
      loadConfigFile(configPath);
      throw new Error("expected loadConfigFile to throw");
    } catch (error) {
      expect((error as Error).message).toContain("cwd");
    }
  });

  // Post-mission sweep fix S6: an empty-string cwd used to pass validation
  // and then resolve to process.cwd() — the real project directory — so a
  // config typo silently turned "isolated disposable temp dir" into "run
  // every CLI step against the real repo, and never clean it up".
  it.each([
    ["an explicitly empty cwd", 'cwd: ""\n'],
    ["a whitespace-only cwd", 'cwd: "   "\n'],
  ])("rejects %s, naming the field", (_label, contents) => {
    const configPath = writeConfig(contents);

    expect(() => loadConfigFile(configPath)).toThrow(/invalid configuration/i);
    try {
      loadConfigFile(configPath);
      throw new Error("expected loadConfigFile to throw");
    } catch (error) {
      expect((error as Error).message).toContain("cwd");
    }
  });

  it("still accepts a non-empty cwd", () => {
    const configPath = writeConfig("cwd: ./sandbox\n");

    expect(loadConfigFile(configPath).cwd).toBe("./sandbox");
  });
});

describe("mergeConfig: cwd and captureLimit pass-through", () => {
  const configWithCliKeys = {
    baseUrl: "http://config.com",
    timeout: 5000,
    specsDir: "specs/",
    cwd: "./sandbox",
    captureLimit: 2_000_000,
  };

  it("preserves cwd and captureLimit from the loaded config when CLI options declare neither", () => {
    const merged = mergeConfig(configWithCliKeys, {
      baseUrl: "http://cli.com",
    });

    expect(merged.cwd).toBe("./sandbox");
    expect(merged.captureLimit).toBe(2_000_000);
  });

  it("preserves cwd and captureLimit through a merge with no CLI options at all", () => {
    const merged = mergeConfig(configWithCliKeys, {});

    expect(merged.cwd).toBe("./sandbox");
    expect(merged.captureLimit).toBe(2_000_000);
  });

  it("does not fabricate cwd or captureLimit when config-level values are absent", () => {
    const configWithoutCliKeys = {
      baseUrl: "http://config.com",
      timeout: 5000,
      specsDir: "specs/",
    };

    const merged = mergeConfig(configWithoutCliKeys, {
      baseUrl: "http://cli.com",
    });

    expect(merged.cwd).toBeUndefined();
    expect(merged.captureLimit).toBeUndefined();
  });
});

describe("config-level setup stays web-only", () => {
  it("rejects a run step in config-level setup, naming the offending verb", () => {
    const configPath = writeConfig('setup:\n  - run: "flowspec init"\n');

    try {
      loadConfigFile(configPath);
      throw new Error("expected loadConfigFile to throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("setup");
      expect(message).toContain("run");
    }
  });

  it.each([
    [
      "an extra unrecognized key on an otherwise-valid verb",
      "setup:\n  - visit: /x\n    bogus_extra_key: y\n",
      "bogus_extra_key",
    ],
    [
      "a wrong value type on an otherwise-valid verb",
      "setup:\n  - visit: 123\n",
      "Expected string",
    ],
  ])("rejects %s with the schema's own specific message, not the generic wrong-verb wrapper", (_label, configYaml, expectedDetail) => {
    // A malformed-but-VALID-verb step (visit IS a supported config-level
    // setup verb) must surface FlowStepSchema's own specific issue — e.g.
    // "Unrecognized key(s)" for an extra key, or a type-mismatch message
    // for a bad value — not the generic wrong-verb-family wrapper message
    // ("Unsupported step ... (web steps only)"), which would misleadingly
    // imply `visit` itself isn't a supported verb when it is. Mirrors
    // src/types.ts's validateStepForSurface two-tier pattern: verb-family
    // mismatch gets the custom wrapper; same-family-but-malformed gets the
    // matched schema's own safeParse issues.
    const configPath = writeConfig(configYaml);

    try {
      loadConfigFile(configPath);
      throw new Error("expected loadConfigFile to throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(expectedDetail);
      expect(message).not.toContain("Unsupported step");
    }
  });
});

describe("captureLimit's downstream default is DEFAULT_CAPTURE_LIMIT, not a config-level default", () => {
  it("DEFAULT_CONFIG has no captureLimit or cwd field", () => {
    expect(DEFAULT_CONFIG.captureLimit).toBeUndefined();
    expect(DEFAULT_CONFIG.cwd).toBeUndefined();
  });

  it("an empty config file loads with captureLimit and cwd both absent, via loadConfig", () => {
    const configPath = writeConfig("");
    expect(existsSync(configPath)).toBe(true);

    const config = loadConfig(tempDir);

    expect(config.captureLimit).toBeUndefined();
    expect(config.cwd).toBeUndefined();
    // Sanity: the real enforcement constant exists and is what a consumer
    // (WI-806's exec path) falls back to — this file only asserts config
    // loading does not itself apply that default.
    expect(DEFAULT_CAPTURE_LIMIT).toBe(5 * 1024 * 1024);
  });
});
