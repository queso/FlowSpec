import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIG_FILE_NAME,
  DEFAULT_CONFIG,
  loadConfigFile,
  mergeConfig,
} from "../src/config";

/**
 * `publicEnv` lists env names an api flow reads normally but does not treat
 * as secrets (no redaction, no short-value warning).
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flowspec-public-env-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function load(contents: string) {
  const path = join(dir, CONFIG_FILE_NAME);
  writeFileSync(path, contents);
  return loadConfigFile(path);
}

describe("publicEnv config key", () => {
  it("loads a list of env names", () => {
    const config = load("publicEnv: [PLATFORM_FAKE_URL, RUN_ID]\n");
    expect(config.publicEnv).toEqual(["PLATFORM_FAKE_URL", "RUN_ID"]);
  });

  it("is absent by default", () => {
    expect(load("baseUrl: http://localhost:3000\n").publicEnv).toBeUndefined();
  });

  it("is carried through mergeConfig", () => {
    const merged = mergeConfig(
      { ...DEFAULT_CONFIG, publicEnv: ["RUN_ID"] },
      {},
    );
    expect(merged.publicEnv).toEqual(["RUN_ID"]);
  });

  it("rejects a value that is not a list", () => {
    expect(() => load("publicEnv: RUN_ID\n")).toThrow(
      /Invalid configuration: publicEnv/,
    );
  });

  it("rejects non-string members", () => {
    expect(() => load("publicEnv: [RUN_ID, 42]\n")).toThrow(
      /Invalid configuration: publicEnv\.1/,
    );
  });

  it("rejects a member that is not a valid env name", () => {
    expect(() => load('publicEnv: ["RUN ID"]\n')).toThrow(
      /publicEnv\.0: .*"RUN ID"/,
    );
  });
});
