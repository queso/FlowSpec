/**
 * Tests for WI-769: ${VAR} interpolation from process.env in
 * flowspec.config.yaml string values, resolved at load time.
 *
 * This is a parser/security-relevant item (untrusted-shape input
 * substitution with a hard-fail-on-unset requirement), so the test list
 * below is a matrix sweep across position (value vs key, top-level vs
 * nested), well-formedness (closed vs unclosed braces, valid vs invalid
 * identifier), and variable presence (set / set-empty / unset) rather than
 * one representative case per acceptance criterion.
 *
 * Every test that depends on a specific process.env variable explicitly
 * sets/deletes that variable and restores it in afterEach — never relies on
 * the ambient shell being clean (dedicated FLOWSPEC_TEST_* names are used
 * throughout to avoid colliding with real environment variables).
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_FILE_NAME, loadConfigFile } from "../src/config";
import { parseFlowSpec } from "../src/parser";

const TOKEN_VALUE = "secret-abc123";

// Dedicated test-only env var names, deliberately namespaced to avoid
// colliding with real environment variables (or the ambient shell state).
const ENV_KEYS = [
  "FLOWSPEC_TEST_TOKEN",
  "FLOWSPEC_TEST_HOST",
  "FLOWSPEC_TEST_ENTRY_PATH",
  "FLOWSPEC_TEST_EMPTY",
  "FLOWSPEC_TEST_MISSING",
  "FLOWSPEC_TEST_SHOULD_NOT_SUB",
] as const;

let savedEnv: Record<string, string | undefined>;
let tempDir: string;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  tempDir = join(tmpdir(), `flowspec-interpolation-test-${Date.now()}`);
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

describe("${VAR} interpolation in baseUrl", () => {
  it("substitutes a set variable into baseUrl", () => {
    process.env.FLOWSPEC_TEST_TOKEN = TOKEN_VALUE;
    const configPath = writeConfig(
      "baseUrl: https://preview.example.dev?_auth=${FLOWSPEC_TEST_TOKEN}\n",
    );

    const config = loadConfigFile(configPath);

    expect(config.baseUrl).toBe(
      `https://preview.example.dev?_auth=${TOKEN_VALUE}`,
    );
  });

  it("substitutes multiple distinct variables within a single string", () => {
    process.env.FLOWSPEC_TEST_HOST = "preview.example.dev";
    process.env.FLOWSPEC_TEST_TOKEN = TOKEN_VALUE;
    const configPath = writeConfig(
      "baseUrl: https://${FLOWSPEC_TEST_HOST}?_auth=${FLOWSPEC_TEST_TOKEN}\n",
    );

    const config = loadConfigFile(configPath);

    expect(config.baseUrl).toBe(
      `https://preview.example.dev?_auth=${TOKEN_VALUE}`,
    );
  });
});

describe("${VAR} well-formedness matrix (specsDir, unconstrained string field)", () => {
  // specsDir has no format constraint (unlike baseUrl's z.string().url()),
  // so these cases isolate interpolation behavior from schema validation.
  it.each([
    ["well-formed reference", "${FLOWSPEC_TEST_TOKEN}", () => TOKEN_VALUE],
    [
      "well-formed reference with surrounding text",
      "specs/${FLOWSPEC_TEST_TOKEN}/e2e",
      () => `specs/${TOKEN_VALUE}/e2e`,
    ],
    [
      "unclosed brace is left byte-identical",
      "specs-${-no-close/",
      (raw: string) => raw,
    ],
    [
      "invalid identifier characters left byte-identical",
      "${not-an-identifier}",
      (raw: string) => raw,
    ],
    [
      "no braces at all is left byte-identical",
      "$FLOWSPEC_TEST_TOKEN",
      (raw: string) => raw,
    ],
  ])("%s", (_label, rawValue, expected) => {
    process.env.FLOWSPEC_TEST_TOKEN = TOKEN_VALUE;
    const configPath = writeConfig(`specsDir: "${rawValue}"\n`);

    const config = loadConfigFile(configPath);

    expect(config.specsDir).toBe(expected(rawValue));
  });
});

describe("${VAR} interpolation scope", () => {
  it("substitutes inside nested setup step string values (recursive walk)", () => {
    process.env.FLOWSPEC_TEST_ENTRY_PATH = "dashboard";
    const configPath = writeConfig(
      `setup:
  - visit: /\${FLOWSPEC_TEST_ENTRY_PATH}
`,
    );

    const config = loadConfigFile(configPath);

    expect(config.setup).toEqual([{ visit: "/dashboard" }]);
  });

  it("substitutes inside fill step VALUES but leaves fill step KEYS byte-identical", () => {
    process.env.FLOWSPEC_TEST_TOKEN = TOKEN_VALUE;
    const configPath = writeConfig(
      `setup:
  - visit: /login
  - fill:
      "\${FLOWSPEC_TEST_SHOULD_NOT_SUB}": "value-\${FLOWSPEC_TEST_TOKEN}"
`,
    );

    const config = loadConfigFile(configPath);

    expect(config.setup).toEqual([
      { visit: "/login" },
      {
        fill: {
          "${FLOWSPEC_TEST_SHOULD_NOT_SUB}": `value-${TOKEN_VALUE}`,
        },
      },
    ]);
  });

  it("leaves a native numeric field (timeout) untouched while substituting other fields", () => {
    process.env.FLOWSPEC_TEST_TOKEN = TOKEN_VALUE;
    const configPath = writeConfig(
      `baseUrl: https://example.com?_auth=\${FLOWSPEC_TEST_TOKEN}
timeout: 5000
`,
    );

    const config = loadConfigFile(configPath);

    expect(config.timeout).toBe(5000);
    expect(config.baseUrl).toBe(`https://example.com?_auth=${TOKEN_VALUE}`);
  });
});

describe("${VAR} presence: set vs set-empty vs unset", () => {
  it("substitutes a variable that is explicitly set to an empty string (does not treat set-empty as unset)", () => {
    process.env.FLOWSPEC_TEST_EMPTY = "";
    const configPath = writeConfig(
      'specsDir: "before-${FLOWSPEC_TEST_EMPTY}-after"\n',
    );

    const config = loadConfigFile(configPath);

    expect(config.specsDir).toBe("before--after");
  });

  it("throws an error naming the missing variable and the config file path for an unset variable", () => {
    // FLOWSPEC_TEST_MISSING is guaranteed absent (deleted in beforeEach and
    // never set in this test).
    const configPath = writeConfig(
      'specsDir: "specs-${FLOWSPEC_TEST_MISSING}/"\n',
    );

    expect(() => loadConfigFile(configPath)).toThrow();
    try {
      loadConfigFile(configPath);
      throw new Error("expected loadConfigFile to throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("FLOWSPEC_TEST_MISSING");
      expect(message).toContain(configPath);
    }
  });

  it("never substitutes an unset variable with an empty string instead of throwing", () => {
    const configPath = writeConfig(
      'baseUrl: "https://example.com?_auth=${FLOWSPEC_TEST_MISSING}"\n',
    );

    // If this silently fell back to "", loadConfigFile would return a
    // config with baseUrl "https://example.com?_auth=" instead of throwing.
    expect(() => loadConfigFile(configPath)).toThrow();
  });
});

describe("${VAR} presence: identifiers that only resolve via Object.prototype", () => {
  // Regression guard for a real gap found in review: process.env inherits
  // from Object.prototype, so a naive `process.env[varName] === undefined`
  // check treats "constructor", "toString", "__proto__", etc. as "set"
  // (they resolve to inherited functions/objects, never to undefined) even
  // though no real environment ever sets them. That silently substitutes
  // prototype-chain noise instead of throwing the same
  // missing-variable error any other unset name would produce — exactly
  // the "looks correct but is wrong" failure class this item's NFR-3
  // framing exists to prevent, just reached through a different input
  // shape than a plain unset name.
  const PROTOTYPE_NAMES = [
    "constructor",
    "toString",
    "__proto__",
    "hasOwnProperty",
    "valueOf",
    "isPrototypeOf",
  ] as const;

  let savedOwnValues: Record<string, string | undefined>;

  beforeEach(() => {
    savedOwnValues = {};
    for (const name of PROTOTYPE_NAMES) {
      // None of these are ever legitimately set as real env vars, but if
      // the ambient shell somehow has one as an OWN property, save/restore
      // it rather than assuming the shell is clean. delete() on a purely
      // inherited (non-own) property is a safe no-op.
      const env = process.env as Record<string, string | undefined>;
      savedOwnValues[name] = Object.hasOwn(env, name) ? env[name] : undefined;
      delete env[name];
    }
  });

  afterEach(() => {
    const env = process.env as Record<string, string | undefined>;
    for (const name of PROTOTYPE_NAMES) {
      const saved = savedOwnValues[name];
      if (saved !== undefined) {
        env[name] = saved;
      } else {
        delete env[name];
      }
    }
  });

  it.each(
    PROTOTYPE_NAMES,
  )("throws for '%s', an identifier that resolves via Object.prototype rather than a real env var", (varName) => {
    const configPath = writeConfig(`specsDir: "before-\${${varName}}-after"\n`);

    expect(() => loadConfigFile(configPath)).toThrow();
    try {
      loadConfigFile(configPath);
      throw new Error("expected loadConfigFile to throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(varName);
      expect(message).toContain(configPath);
    }
  });
});

describe("interpolation ordering (runs before schema validation)", () => {
  it("reports the missing-variable error, not a schema validation error, for an unset variable in an otherwise-invalid-looking URL", () => {
    // If interpolation ran AFTER safeParse (or not at all), this raw
    // unsubstituted string would fail z.string().url() and surface as
    // "Invalid configuration: baseUrl: Invalid url" instead of naming the
    // missing variable.
    const configPath = writeConfig('baseUrl: "${FLOWSPEC_TEST_MISSING}"\n');

    try {
      loadConfigFile(configPath);
      throw new Error("expected loadConfigFile to throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("FLOWSPEC_TEST_MISSING");
      expect(message).not.toContain("Invalid configuration");
    }
  });
});

describe("interpolation does not introduce shared-state surprises across loads", () => {
  it("does not leak a variable's value from one load into a later load with a different value", () => {
    process.env.FLOWSPEC_TEST_TOKEN = "first-value";
    const configPath = writeConfig('specsDir: "${FLOWSPEC_TEST_TOKEN}"\n');
    const first = loadConfigFile(configPath);
    expect(first.specsDir).toBe("first-value");

    process.env.FLOWSPEC_TEST_TOKEN = "second-value";
    const second = loadConfigFile(configPath);
    expect(second.specsDir).toBe("second-value");

    // The first result must not have been mutated by the second load.
    expect(first.specsDir).toBe("first-value");
  });

  it("does not alias the setup array between independent loadConfigFile calls", () => {
    const configPath = writeConfig(
      `setup:
  - visit: /login
`,
    );

    const first = loadConfigFile(configPath);
    // biome-ignore lint/style/noNonNullAssertion: test-only mutation to prove independence
    (first.setup![0] as { visit: string }).visit = "/mutated";

    const second = loadConfigFile(configPath);

    expect(second.setup).toEqual([{ visit: "/login" }]);
  });
});

describe("specs/** exclusion (regression guard, not new behavior)", () => {
  it("does not interpolate ${VAR} inside flow spec YAML parsed by parseFlowSpec", () => {
    process.env.FLOWSPEC_TEST_TOKEN = TOKEN_VALUE;
    const flowYaml = `
name: test-flow
description: Test
steps:
  - visit: /home
expect:
  - visible: "\${FLOWSPEC_TEST_TOKEN}"
`;

    const result = parseFlowSpec(flowYaml);

    expect(result.expect).toEqual([{ visible: "${FLOWSPEC_TEST_TOKEN}" }]);
  });
});
