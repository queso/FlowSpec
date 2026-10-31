import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseFlowFile } from "../src/parser";
import {
  BUY_SCOPE,
  createSiloFixture,
  QUOTE_SCOPE,
  SHOPIFY_PENDING_POLLS,
} from "./api-server";

/**
 * The silo-modeled example flows in test/fixtures/flows/api/, run through
 * the real CLI entry point against the silo fixture servers:
 *
 * - silo/ holds flows that must pass: a quote and a dry run, a quote-only
 *   key refused a buy, an idempotent replayed buy with one upstream call,
 *   an async Shopify label polled to PURCHASED, and a late TikTok label
 *   found by a retried GET.
 * - silo-late/ holds the `timeout: 0` check against that late label, which
 *   must fail after a single lookup.
 */

const CLI_PATH = join(__dirname, "..", "src", "index.ts");
const FLOWS_DIR = join(__dirname, "fixtures", "flows", "api");
const PASSING_DIR = join(FLOWS_DIR, "silo");
const LATE_DIR = join(FLOWS_DIR, "silo-late");

const QUOTE_KEY = "porter_quote_only_key_01";
const BUY_KEY = "porter_quote_buy_key_02";

function runCli(
  path: string,
  env: Record<string, string>,
  baseUrl: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(
      "bun",
      ["run", CLI_PATH, "run", path, "--base-url", baseUrl],
      {
        cwd: join(__dirname, ".."),
        env: { ...process.env, ...env },
        timeout: 25000,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("close", (code) =>
      resolve({ stdout, stderr, exitCode: code ?? 1 }),
    );
  });
}

function flowFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".flow.yaml"))
    .map((file) => join(dir, file));
}

describe("silo example flows", () => {
  it("all parse as surface: api flows", () => {
    for (const file of [...flowFiles(PASSING_DIR), ...flowFiles(LATE_DIR)]) {
      expect(parseFlowFile(file).surface).toBe("api");
    }
  });

  describe("against the fixture", () => {
    const fixture = createSiloFixture({
      keys: { [QUOTE_KEY]: [QUOTE_SCOPE], [BUY_KEY]: [QUOTE_SCOPE, BUY_SCOPE] },
    });
    let env: Record<string, string>;

    beforeAll(async () => {
      await fixture.start();
      env = {
        PORTER_QUOTE_KEY: QUOTE_KEY,
        PORTER_BUY_KEY: BUY_KEY,
        PLATFORM_FAKE_URL: fixture.platformUrl,
      };
    });

    afterAll(async () => {
      await fixture.stop();
    });

    it("the passing flows all pass", async () => {
      fixture.resetObservations();
      const result = await runCli(PASSING_DIR, env, fixture.porterUrl);

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      for (const name of [
        "quote-and-dry-run",
        "quote-key-cannot-buy",
        "label-buy-is-idempotent",
        "shopify-label-is-polled-until-purchased",
        "tiktok-label-appears-after-buy",
      ]) {
        expect(result.stdout).toContain(`✓ ${name}`);
      }
      expect(result.stdout).toContain("5 flows: 5 passed, 0 failed");

      // What the server saw: the Shopify label was polled until it was
      // purchased, its buy was sent once, and the late TikTok label was
      // looked up twice (404, then 200).
      expect(fixture.requestCount("POST", "/shopify/arcane/labels")).toBe(1);
      expect(fixture.requestCount("GET", "/shopify/arcane/labels/lbl_1")).toBe(
        SHOPIFY_PENDING_POLLS + 1,
      );
      const labelLookups = fixture.requestLog.filter((entry) =>
        entry.startsWith("GET /tiktok/arcane/labels/pkg_"),
      );
      expect(labelLookups).toHaveLength(2);

      // Keys never appear in output.
      expect(result.stdout).not.toContain(QUOTE_KEY);
      expect(result.stdout).not.toContain(BUY_KEY);
    });

    it("the timeout: 0 check on a late label fails after one lookup", async () => {
      fixture.resetObservations();
      const result = await runCli(LATE_DIR, env, fixture.porterUrl);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("✗ tiktok-label-exists-immediately");
      expect(result.stdout).toContain("Expected status 200 but got 404");
      expect(result.stdout).not.toContain("requests over");
      const labelLookups = fixture.requestLog.filter((entry) =>
        entry.startsWith("GET /tiktok/arcane/labels/pkg_"),
      );
      expect(labelLookups).toHaveLength(1);
      expect(result.stdout).not.toContain(BUY_KEY);
    });
  });
});
