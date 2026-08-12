/**
 * Tests for WI-768: setup block support in flowspec.config.yaml, carried
 * through mergeConfig.
 *
 * Contract pinned by the work item (same shape as WI-767's schema-foundation
 * pin, applied to FlowSpecConfigSchema):
 *  - setup: z.array(FlowStepSchema).optional() on FlowSpecConfigSchema
 *  - mergeConfig must carry config.setup through untouched (CLI options never
 *    supply or override setup)
 *  - DEFAULT_CONFIG / empty-file loading stay setup-free
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

describe("FlowSpecConfigSchema / loadConfigFile setup field", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `flowspec-config-setup-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("loads a setup list of valid steps, in order", () => {
    const configPath = join(tempDir, CONFIG_FILE_NAME);
    writeFileSync(
      configPath,
      `baseUrl: http://example.com
setup:
  - visit: /login
  - fill:
      Email: admin@example.com
  - click: Sign In
`,
    );

    const config = loadConfigFile(configPath);

    expect(config.setup).toEqual([
      { visit: "/login" },
      { fill: { Email: "admin@example.com" } },
      { click: "Sign In" },
    ]);
  });

  it("returns setup undefined and default baseUrl/timeout/specsDir when the config has no setup key", () => {
    const configPath = join(tempDir, CONFIG_FILE_NAME);
    writeFileSync(configPath, "baseUrl: http://custom.com\n");

    const config = loadConfigFile(configPath);

    expect(config.setup).toBeUndefined();
    expect(config.baseUrl).toBe("http://custom.com");
    expect(config.timeout).toBe(DEFAULT_CONFIG.timeout);
    expect(config.specsDir).toBe(DEFAULT_CONFIG.specsDir);
  });

  it("throws 'Invalid configuration: ...' naming the setup path for a malformed step, before returning any config", () => {
    const configPath = join(tempDir, CONFIG_FILE_NAME);
    writeFileSync(
      configPath,
      `setup:
  - visit: /login
    extra: field
`,
    );

    expect(() => loadConfigFile(configPath)).toThrow(/invalid configuration/i);
    try {
      loadConfigFile(configPath);
      throw new Error("expected loadConfigFile to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/setup/);
    }
  });

  it("throws for an unknown action in setup, naming the setup path", () => {
    const configPath = join(tempDir, CONFIG_FILE_NAME);
    writeFileSync(
      configPath,
      `setup:
  - unknown_action: value
`,
    );

    expect(() => loadConfigFile(configPath)).toThrow(/invalid configuration/i);
    try {
      loadConfigFile(configPath);
      throw new Error("expected loadConfigFile to throw");
    } catch (error) {
      expect((error as Error).message).toMatch(/setup/);
    }
  });
});

describe("mergeConfig setup pass-through", () => {
  const configWithSetup = {
    baseUrl: "http://config.com",
    timeout: 5000,
    specsDir: "specs/",
    setup: [{ visit: "/login" }, { click: "Sign In" }],
  };

  it("carries config-level setup through unchanged when both CLI options are supplied", () => {
    const merged = mergeConfig(configWithSetup, {
      baseUrl: "http://cli.com",
      timeout: 3000,
    });

    expect(merged.baseUrl).toBe("http://cli.com");
    expect(merged.timeout).toBe(3000);
    expect(merged.setup).toEqual(configWithSetup.setup);
  });

  it("carries config-level setup through unchanged when no CLI options are supplied", () => {
    const merged = mergeConfig(configWithSetup, {});

    expect(merged.setup).toEqual(configWithSetup.setup);
  });

  it("carries config-level setup through unchanged with a partial CLI override (timeout only)", () => {
    const merged = mergeConfig(configWithSetup, { timeout: 2000 });

    expect(merged.timeout).toBe(2000);
    expect(merged.baseUrl).toBe(configWithSetup.baseUrl);
    expect(merged.setup).toEqual(configWithSetup.setup);
  });

  it("does not fabricate a setup array when config-level setup is absent", () => {
    const configWithoutSetup = {
      baseUrl: "http://config.com",
      timeout: 5000,
      specsDir: "specs/",
    };

    const merged = mergeConfig(configWithoutSetup, {
      baseUrl: "http://cli.com",
    });

    expect(merged.setup).toBeUndefined();
  });
});

describe("DEFAULT_CONFIG and empty-config-file path stay setup-free", () => {
  it("DEFAULT_CONFIG has no setup field", () => {
    expect(DEFAULT_CONFIG.setup).toBeUndefined();
  });

  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `flowspec-config-setup-empty-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns DEFAULT_CONFIG (no setup) for an empty config file", () => {
    const configPath = join(tempDir, CONFIG_FILE_NAME);
    writeFileSync(configPath, "");

    const config = loadConfigFile(configPath);

    expect(config).toEqual(DEFAULT_CONFIG);
    expect(config.setup).toBeUndefined();
  });

  it("leaves existing baseUrl/timeout/specsDir consumers unaffected via loadConfig when a setup block is present", () => {
    const configPath = join(tempDir, CONFIG_FILE_NAME);
    writeFileSync(
      configPath,
      `baseUrl: http://from-file.com
setup:
  - visit: /login
`,
    );

    const config = loadConfig(tempDir);

    expect(config.baseUrl).toBe("http://from-file.com");
    expect(config.timeout).toBe(DEFAULT_CONFIG.timeout);
    expect(config.specsDir).toBe(DEFAULT_CONFIG.specsDir);
    expect(config.setup).toEqual([{ visit: "/login" }]);
  });
});
