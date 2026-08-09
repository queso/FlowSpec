/**
 * Configuration file tests for FlowSpec
 *
 * These tests verify that:
 * 1. Project configuration files exist and contain required settings (PRD-0001)
 * 2. FlowSpec config loading works correctly (flowspec.config.yaml)
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  findConfigFile,
  loadConfig,
  loadConfigFile,
  mergeConfig,
} from "../src/config";

const PROJECT_ROOT = join(__dirname, "..");

describe("Project Configuration", () => {
  it("should have valid package.json with required dependencies", () => {
    const packageJsonPath = join(PROJECT_ROOT, "package.json");
    expect(existsSync(packageJsonPath)).toBe(true);

    const content = readFileSync(packageJsonPath, "utf-8");
    const pkg = JSON.parse(content);

    // Check key dependencies
    expect(pkg.dependencies["agent-browser"]).toBeDefined();
    expect(pkg.devDependencies.express).toBeDefined();
    expect(pkg.devDependencies.typescript).toBeDefined();
  });

  it("should have valid tsconfig.json with strict mode", () => {
    const tsconfigPath = join(PROJECT_ROOT, "tsconfig.json");
    expect(existsSync(tsconfigPath)).toBe(true);

    const content = readFileSync(tsconfigPath, "utf-8");
    const tsconfig = JSON.parse(content);

    expect(tsconfig.compilerOptions).toBeDefined();
    expect(tsconfig.compilerOptions.strict).toBe(true);
  });

  it("should run tests on bun's built-in runner with an explicit timeout", () => {
    const content = readFileSync(join(PROJECT_ROOT, "package.json"), "utf-8");
    const pkg = JSON.parse(content);

    // Bun's 5s default is too short for the browser-driven tests in
    // runner.test.ts, so both test scripts must raise it explicitly.
    for (const script of [pkg.scripts.test, pkg.scripts["test:coverage"]]) {
      expect(script).toMatch(/^bun test\b/);
      expect(script).toMatch(/--timeout \d+/);
    }
  });
});

describe("FlowSpec Config Loading", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `flowspec-config-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("CONFIG_FILE_NAME", () => {
    it("should be flowspec.config.yaml", () => {
      expect(CONFIG_FILE_NAME).toBe("flowspec.config.yaml");
    });
  });

  describe("DEFAULT_CONFIG", () => {
    it("should have baseUrl of http://localhost:3000", () => {
      expect(DEFAULT_CONFIG.baseUrl).toBe("http://localhost:3000");
    });

    it("should have timeout of 10000", () => {
      expect(DEFAULT_CONFIG.timeout).toBe(10000);
    });

    it("should have specsDir of specs/", () => {
      expect(DEFAULT_CONFIG.specsDir).toBe("specs/");
    });
  });

  describe("findConfigFile", () => {
    it("should find config file in the given directory", () => {
      const configPath = join(tempDir, CONFIG_FILE_NAME);
      writeFileSync(configPath, "baseUrl: http://test.com");

      const result = findConfigFile(tempDir);

      expect(result).toBe(configPath);
    });

    it("should return undefined when no config file exists", () => {
      const result = findConfigFile(tempDir);

      expect(result).toBeUndefined();
    });

    it("should find config file in parent directory", () => {
      const childDir = join(tempDir, "src", "components");
      mkdirSync(childDir, { recursive: true });

      const configPath = join(tempDir, CONFIG_FILE_NAME);
      writeFileSync(configPath, "baseUrl: http://test.com");

      const result = findConfigFile(childDir);

      expect(result).toBe(configPath);
    });

    it("should find nearest config file when multiple exist", () => {
      const childDir = join(tempDir, "packages", "app");
      mkdirSync(childDir, { recursive: true });

      // Config in root
      writeFileSync(
        join(tempDir, CONFIG_FILE_NAME),
        "baseUrl: http://root.com",
      );

      // Config in child
      const childConfigPath = join(childDir, CONFIG_FILE_NAME);
      writeFileSync(childConfigPath, "baseUrl: http://child.com");

      const result = findConfigFile(childDir);

      expect(result).toBe(childConfigPath);
    });
  });

  describe("loadConfigFile", () => {
    it("should load and parse valid config file", () => {
      const configPath = join(tempDir, CONFIG_FILE_NAME);
      writeFileSync(
        configPath,
        `baseUrl: http://example.com:8080
timeout: 5000
specsDir: test-specs/
`,
      );

      const config = loadConfigFile(configPath);

      expect(config.baseUrl).toBe("http://example.com:8080");
      expect(config.timeout).toBe(5000);
      expect(config.specsDir).toBe("test-specs/");
    });

    it("should use defaults for missing fields", () => {
      const configPath = join(tempDir, CONFIG_FILE_NAME);
      writeFileSync(configPath, "baseUrl: http://custom.com\n");

      const config = loadConfigFile(configPath);

      expect(config.baseUrl).toBe("http://custom.com");
      expect(config.timeout).toBe(DEFAULT_CONFIG.timeout);
      expect(config.specsDir).toBe(DEFAULT_CONFIG.specsDir);
    });

    it("should return defaults for empty file", () => {
      const configPath = join(tempDir, CONFIG_FILE_NAME);
      writeFileSync(configPath, "");

      const config = loadConfigFile(configPath);

      expect(config).toEqual(DEFAULT_CONFIG);
    });

    it("should throw for non-existent file", () => {
      const configPath = join(tempDir, "nonexistent.yaml");

      expect(() => loadConfigFile(configPath)).toThrow(/not found/i);
    });

    it("should throw for invalid YAML syntax", () => {
      const configPath = join(tempDir, CONFIG_FILE_NAME);
      writeFileSync(configPath, "baseUrl: [\ninvalid yaml");

      expect(() => loadConfigFile(configPath)).toThrow(/invalid yaml/i);
    });

    it("should throw for invalid baseUrl (not a URL)", () => {
      const configPath = join(tempDir, CONFIG_FILE_NAME);
      writeFileSync(configPath, "baseUrl: not-a-url\n");

      expect(() => loadConfigFile(configPath)).toThrow(/invalid/i);
    });

    it("should throw for negative timeout", () => {
      const configPath = join(tempDir, CONFIG_FILE_NAME);
      writeFileSync(configPath, "timeout: -1000\n");

      expect(() => loadConfigFile(configPath)).toThrow(/invalid/i);
    });
  });

  describe("loadConfig", () => {
    it("should return config from file when it exists", () => {
      const configPath = join(tempDir, CONFIG_FILE_NAME);
      writeFileSync(configPath, "baseUrl: http://from-file.com\n");

      const config = loadConfig(tempDir);

      expect(config.baseUrl).toBe("http://from-file.com");
    });

    it("should return defaults when no config file exists", () => {
      const config = loadConfig(tempDir);

      expect(config).toEqual(DEFAULT_CONFIG);
    });
  });

  describe("mergeConfig", () => {
    it("should use CLI options when provided", () => {
      const config = {
        baseUrl: "http://config.com",
        timeout: 5000,
        specsDir: "specs/",
      };

      const merged = mergeConfig(config, {
        baseUrl: "http://cli.com",
        timeout: 3000,
      });

      expect(merged.baseUrl).toBe("http://cli.com");
      expect(merged.timeout).toBe(3000);
    });

    it("should use config values when CLI options are undefined", () => {
      const config = {
        baseUrl: "http://config.com",
        timeout: 5000,
        specsDir: "specs/",
      };

      const merged = mergeConfig(config, {});

      expect(merged.baseUrl).toBe("http://config.com");
      expect(merged.timeout).toBe(5000);
    });

    it("should preserve specsDir from config (not overridable via CLI)", () => {
      const config = {
        baseUrl: "http://config.com",
        timeout: 5000,
        specsDir: "custom-specs/",
      };

      const merged = mergeConfig(config, {
        baseUrl: "http://cli.com",
      });

      expect(merged.specsDir).toBe("custom-specs/");
    });

    it("should handle partial CLI options", () => {
      const config = {
        baseUrl: "http://config.com",
        timeout: 5000,
        specsDir: "specs/",
      };

      const merged = mergeConfig(config, {
        timeout: 2000,
      });

      expect(merged.baseUrl).toBe("http://config.com");
      expect(merged.timeout).toBe(2000);
    });
  });
});

describe("Config schema validation", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `flowspec-schema-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should accept valid HTTP URL", () => {
    const configPath = join(tempDir, CONFIG_FILE_NAME);
    writeFileSync(configPath, "baseUrl: http://localhost:3000\n");

    const config = loadConfigFile(configPath);
    expect(config.baseUrl).toBe("http://localhost:3000");
  });

  it("should accept valid HTTPS URL", () => {
    const configPath = join(tempDir, CONFIG_FILE_NAME);
    writeFileSync(configPath, "baseUrl: https://example.com\n");

    const config = loadConfigFile(configPath);
    expect(config.baseUrl).toBe("https://example.com");
  });

  it("should accept URL with port", () => {
    const configPath = join(tempDir, CONFIG_FILE_NAME);
    writeFileSync(configPath, "baseUrl: http://localhost:8080\n");

    const config = loadConfigFile(configPath);
    expect(config.baseUrl).toBe("http://localhost:8080");
  });

  it("should accept integer timeout", () => {
    const configPath = join(tempDir, CONFIG_FILE_NAME);
    writeFileSync(configPath, "timeout: 15000\n");

    const config = loadConfigFile(configPath);
    expect(config.timeout).toBe(15000);
  });

  it("should accept specsDir with trailing slash", () => {
    const configPath = join(tempDir, CONFIG_FILE_NAME);
    writeFileSync(configPath, "specsDir: my-specs/\n");

    const config = loadConfigFile(configPath);
    expect(config.specsDir).toBe("my-specs/");
  });

  it("should accept specsDir without trailing slash", () => {
    const configPath = join(tempDir, CONFIG_FILE_NAME);
    writeFileSync(configPath, "specsDir: my-specs\n");

    const config = loadConfigFile(configPath);
    expect(config.specsDir).toBe("my-specs");
  });
});
