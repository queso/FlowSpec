/**
 * Tests for config-level HTTP headers: `headers` on flowspec.config.yaml,
 * carried through mergeConfig, plus the "headers" FlowError phase that marks
 * a failure while applying those headers to the browser session.
 *
 * Contract pinned here:
 *  - headers: z.record(z.string()).optional() on FlowSpecConfigSchema
 *    (config-level ONLY — flow specs never carry auth/environment concerns,
 *    see adr/0003)
 *  - mergeConfig must carry config.headers through untouched (no CLI option
 *    supplies or overrides headers)
 *  - ${VAR} interpolation applies to header VALUES and never to header KEYS,
 *    matching the existing values-only rule
 *  - FlowErrorSchema.phase accepts "headers" alongside "setup"
 *
 * Every test that depends on a specific process.env variable explicitly
 * sets/deletes that variable and restores it in afterEach — never relies on
 * the ambient shell being clean.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  loadConfigFile,
  mergeConfig,
} from "../src/config";
import { FlowErrorSchema } from "../src/types";

const BYPASS_HEADER = "x-vercel-protection-bypass";
const TOKEN_VALUE = "secret-abc123";

const ENV_KEYS = [
  "FLOWSPEC_TEST_HEADER_TOKEN",
  "FLOWSPEC_TEST_HEADER_MISSING",
  "FLOWSPEC_TEST_HEADER_SHOULD_NOT_SUB",
] as const;

let savedEnv: Record<string, string | undefined>;
let tempDir: string;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  tempDir = join(tmpdir(), `flowspec-config-headers-test-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function writeConfig(contents: string): string {
  const configPath = join(tempDir, CONFIG_FILE_NAME);
  writeFileSync(configPath, contents);
  return configPath;
}

describe("FlowErrorSchema phase enum", () => {
  it("accepts phase 'headers'", () => {
    const result = FlowErrorSchema.safeParse({
      message: "failed to apply headers",
      phase: "headers",
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.phase).toBe("headers");
  });

  it("still accepts phase 'setup' (no regression)", () => {
    const result = FlowErrorSchema.safeParse({
      message: "setup step failed",
      phase: "setup",
      step: 1,
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.phase).toBe("setup");
  });

  it("still accepts an error with no phase at all", () => {
    const result = FlowErrorSchema.safeParse({ message: "step failed" });

    expect(result.success).toBe(true);
    expect(result.success && result.data.phase).toBeUndefined();
  });

  it("accepts a 'headers' error carrying no step or action", () => {
    // A headers failure happens before any step runs, so it has neither.
    const result = FlowErrorSchema.safeParse({
      message: "failed to apply headers",
      phase: "headers",
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.step).toBeUndefined();
    expect(result.success && result.data.action).toBeUndefined();
  });

  it.each([
    "header",
    "headers ",
    "HEADERS",
    "teardown",
    "",
  ])("rejects the invalid phase %o", (phase) => {
    const result = FlowErrorSchema.safeParse({ message: "boom", phase });

    expect(result.success).toBe(false);
  });
});

describe("FlowSpecConfigSchema / loadConfigFile headers field", () => {
  it("loads a headers map of string values", () => {
    const configPath = writeConfig(
      `baseUrl: http://example.com
headers:
  ${BYPASS_HEADER}: abc123
  x-another: second-value
`,
    );

    const config = loadConfigFile(configPath);

    expect(config.headers).toEqual({
      [BYPASS_HEADER]: "abc123",
      "x-another": "second-value",
    });
  });

  it("returns headers undefined when the config has no headers key", () => {
    const configPath = writeConfig("baseUrl: http://custom.com\n");

    const config = loadConfigFile(configPath);

    expect(config.headers).toBeUndefined();
    expect(config.baseUrl).toBe("http://custom.com");
    expect(config.timeout).toBe(DEFAULT_CONFIG.timeout);
    expect(config.specsDir).toBe(DEFAULT_CONFIG.specsDir);
  });

  it("parses an empty headers map as {} — distinguishable from absent", () => {
    const configPath = writeConfig("headers: {}\n");

    const config = loadConfigFile(configPath);

    expect(config.headers).toEqual({});
    expect(config.headers).not.toBeUndefined();
  });

  it("rejects a numeric header value, naming the headers path", () => {
    const configPath = writeConfig(
      `headers:
  x-count: 42
`,
    );

    expect(() => loadConfigFile(configPath)).toThrow(/invalid configuration/i);
    try {
      loadConfigFile(configPath);
      throw new Error("expected loadConfigFile to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/headers/);
    }
  });

  it("rejects a nested-object header value, naming the headers path", () => {
    const configPath = writeConfig(
      `headers:
  x-nested:
    inner: value
`,
    );

    expect(() => loadConfigFile(configPath)).toThrow(/invalid configuration/i);
    try {
      loadConfigFile(configPath);
      throw new Error("expected loadConfigFile to throw");
    } catch (error) {
      expect((error as Error).message).toMatch(/headers/);
    }
  });

  it("rejects a headers value that is not a map at all", () => {
    const configPath = writeConfig("headers: not-a-map\n");

    expect(() => loadConfigFile(configPath)).toThrow(/invalid configuration/i);
  });
});

// The sibling interpolation suite spells "${VAR}" out in its titles; these
// titles avoid the literal placeholder so the file adds no new
// noTemplateCurlyInString lint warnings.
describe("environment-variable interpolation in headers", () => {
  it("substitutes a set variable into a header VALUE", () => {
    process.env.FLOWSPEC_TEST_HEADER_TOKEN = TOKEN_VALUE;
    const configPath = writeConfig(
      `headers:
  ${BYPASS_HEADER}: \${FLOWSPEC_TEST_HEADER_TOKEN}
`,
    );

    const config = loadConfigFile(configPath);

    expect(config.headers).toEqual({ [BYPASS_HEADER]: TOKEN_VALUE });
  });

  it("substitutes within surrounding text in a header value", () => {
    process.env.FLOWSPEC_TEST_HEADER_TOKEN = TOKEN_VALUE;
    const configPath = writeConfig(
      `headers:
  authorization: "Bearer \${FLOWSPEC_TEST_HEADER_TOKEN}"
`,
    );

    const config = loadConfigFile(configPath);

    expect(config.headers).toEqual({ authorization: `Bearer ${TOKEN_VALUE}` });
  });

  it("leaves a reference-shaped header KEY byte-identical while substituting its value", () => {
    process.env.FLOWSPEC_TEST_HEADER_TOKEN = TOKEN_VALUE;
    const configPath = writeConfig(
      `headers:
  "\${FLOWSPEC_TEST_HEADER_SHOULD_NOT_SUB}": "value-\${FLOWSPEC_TEST_HEADER_TOKEN}"
`,
    );

    const config = loadConfigFile(configPath);

    expect(config.headers).toEqual({
      "${FLOWSPEC_TEST_HEADER_SHOULD_NOT_SUB}": `value-${TOKEN_VALUE}`,
    });
  });

  it("throws the missing-variable error naming the variable and config path for an unset variable in a header value", () => {
    const configPath = writeConfig(
      `headers:
  ${BYPASS_HEADER}: \${FLOWSPEC_TEST_HEADER_MISSING}
`,
    );

    expect(() => loadConfigFile(configPath)).toThrow();
    try {
      loadConfigFile(configPath);
      throw new Error("expected loadConfigFile to throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("FLOWSPEC_TEST_HEADER_MISSING");
      expect(message).toContain(configPath);
      // Missing-variable error, not a schema failure.
      expect(message).not.toContain("Invalid configuration");
    }
  });
});

describe("mergeConfig headers pass-through", () => {
  const configWithHeaders = {
    baseUrl: "http://config.com",
    timeout: 5000,
    specsDir: "specs/",
    setup: [{ visit: "/login" }],
    headers: { [BYPASS_HEADER]: "abc123" },
  };

  it("carries config-level headers through unchanged when both CLI options are supplied", () => {
    const merged = mergeConfig(configWithHeaders, {
      baseUrl: "http://cli.com",
      timeout: 3000,
    });

    expect(merged.headers).toEqual(configWithHeaders.headers);
    // No regression on the fields that were already carried through.
    expect(merged.baseUrl).toBe("http://cli.com");
    expect(merged.timeout).toBe(3000);
    expect(merged.specsDir).toBe("specs/");
    expect(merged.setup).toEqual(configWithHeaders.setup);
  });

  it("carries config-level headers through unchanged when no CLI options are supplied", () => {
    const merged = mergeConfig(configWithHeaders, {});

    expect(merged.headers).toEqual(configWithHeaders.headers);
    expect(merged.baseUrl).toBe("http://config.com");
    expect(merged.timeout).toBe(5000);
    expect(merged.setup).toEqual(configWithHeaders.setup);
  });

  it("carries an empty headers map through as {} rather than dropping it", () => {
    const merged = mergeConfig({ ...configWithHeaders, headers: {} }, {});

    expect(merged.headers).toEqual({});
  });

  it("does not fabricate a headers map when config-level headers are absent", () => {
    const merged = mergeConfig(
      {
        baseUrl: "http://config.com",
        timeout: 5000,
        specsDir: "specs/",
      },
      { baseUrl: "http://cli.com" },
    );

    expect(merged.headers).toBeUndefined();
  });
});

describe("DEFAULT_CONFIG and empty-config-file path stay headers-free", () => {
  it("DEFAULT_CONFIG has no headers field", () => {
    expect(DEFAULT_CONFIG.headers).toBeUndefined();
  });

  it("returns DEFAULT_CONFIG (no headers) for an empty config file", () => {
    const configPath = writeConfig("");

    const config = loadConfigFile(configPath);

    expect(config).toEqual(DEFAULT_CONFIG);
    expect(config.headers).toBeUndefined();
  });
});
