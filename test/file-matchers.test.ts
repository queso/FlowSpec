import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileContains, fileExists } from "../src/file-matchers";
import { POLL_INTERVAL } from "../src/runner";

/**
 * Tests for WI-803: retryable file-existence and file-content matchers.
 *
 * Contract pinned by the work item:
 *  - fileExists(absolutePath, timeout?): Promise<MatchFailure | undefined>
 *  - fileContains(absolutePath, expected, timeout?): Promise<MatchFailure | undefined>
 *  - Both follow executeAssertion's retry shape (src/runner.ts:599): a
 *    zero-overhead first check, then poll every POLL_INTERVAL until a
 *    deadline, returning the last failure. Timeout 0 or absent means
 *    exactly one evaluation, no polling, immediate return.
 *  - Callers pass an already-resolved absolute path; these functions do
 *    not resolve relative paths themselves.
 *  - Failure messages name the absolute path (both matchers) and, for
 *    fileContains, the expected text too.
 */

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "flowspec-file-matcher-")),
  );
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("fileExists", () => {
  it("passes on the first check, without waiting a poll interval, when the file already exists", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "already-there.txt");
    writeFileSync(filePath, "content");

    const start = Date.now();
    const result = await fileExists(filePath, 5000);
    const elapsed = Date.now() - start;

    expect(result).toBeUndefined();
    expect(elapsed).toBeLessThan(POLL_INTERVAL);
  });

  it("passes once the file appears mid-window, before the deadline elapses", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "appears-later.txt");

    const start = Date.now();
    const resultPromise = fileExists(filePath, 1000);
    setTimeout(() => writeFileSync(filePath, "now it exists"), 300);
    const result = await resultPromise;
    const elapsed = Date.now() - start;

    expect(result).toBeUndefined();
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(900);
  });

  it("fails after the deadline when the file never appears, naming the resolved absolute path", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "never-appears.txt");

    const result = await fileExists(filePath, POLL_INTERVAL + 50);

    expect(result).toBeDefined();
    expect(result?.message).toContain(filePath);
  });
});

describe("fileContains", () => {
  it("passes on the first check, without waiting a poll interval, when the file already contains the expected text", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "content.txt");
    writeFileSync(filePath, "hello world, this has the needle inside");

    const start = Date.now();
    const result = await fileContains(filePath, "needle", 5000);
    const elapsed = Date.now() - start;

    expect(result).toBeUndefined();
    expect(elapsed).toBeLessThan(POLL_INTERVAL);
  });

  it("passes once the expected text is written mid-window, before the deadline elapses", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "written-later.txt");
    writeFileSync(filePath, "not yet");

    const start = Date.now();
    const resultPromise = fileContains(filePath, "the marker", 1000);
    setTimeout(
      () => writeFileSync(filePath, "now contains the marker text"),
      300,
    );
    const result = await resultPromise;
    const elapsed = Date.now() - start;

    expect(result).toBeUndefined();
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(900);
  });

  it("fails after the deadline with the wrong content, naming the resolved path and the expected text", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "wrong-content.txt");
    writeFileSync(filePath, "irrelevant content");

    const result = await fileContains(
      filePath,
      "the missing needle",
      POLL_INTERVAL + 50,
    );

    expect(result).toBeDefined();
    expect(result?.message).toContain(filePath);
    expect(result?.message).toContain("the missing needle");
  });

  it("fails after the deadline when the file itself never appears, naming the resolved path", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "does-not-exist.txt");

    const result = await fileContains(filePath, "anything", POLL_INTERVAL + 50);

    expect(result).toBeDefined();
    expect(result?.message).toContain(filePath);
  });
});

describe("zero or absent timeout: exactly one evaluation, no polling", () => {
  it("fileExists with timeout 0 fails immediately even if the file appears moments later", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "appears-too-late.txt");

    const start = Date.now();
    const resultPromise = fileExists(filePath, 0);
    // Never actually meant to fire: timeout 0 resolves almost instantly,
    // well before this 50ms timer would — it exists only to prove the
    // early result didn't wait for it. Left uncleared, it fires later
    // (possibly after this test's own afterEach has deleted `dir`),
    // throwing an ENOENT that gets misattributed to whatever test happens
    // to be running concurrently at that moment.
    const staleTimer = setTimeout(
      () => writeFileSync(filePath, "too late"),
      50,
    );
    const result = await resultPromise;
    const elapsed = Date.now() - start;
    clearTimeout(staleTimer);

    expect(result).toBeDefined();
    expect(elapsed).toBeLessThan(POLL_INTERVAL);
  });

  it("fileExists with an absent timeout fails immediately for a missing file", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "absent-timeout.txt");

    const start = Date.now();
    const result = await fileExists(filePath);
    const elapsed = Date.now() - start;

    expect(result).toBeDefined();
    expect(elapsed).toBeLessThan(POLL_INTERVAL);
  });

  it("fileExists with timeout 0 still passes immediately when the file already exists", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "already-there-zero.txt");
    writeFileSync(filePath, "here");

    const result = await fileExists(filePath, 0);

    expect(result).toBeUndefined();
  });

  it("fileContains with timeout 0 fails immediately even if matching content is written moments later", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "content-too-late.txt");
    writeFileSync(filePath, "not yet");

    const start = Date.now();
    const resultPromise = fileContains(filePath, "the marker", 0);
    // Same rationale as the fileExists timeout-0 test above: never meant
    // to actually fire, and left uncleared it can write to `dir` after
    // this test's own afterEach has already removed it.
    const staleTimer = setTimeout(
      () => writeFileSync(filePath, "now contains the marker"),
      50,
    );
    const result = await resultPromise;
    const elapsed = Date.now() - start;
    clearTimeout(staleTimer);

    expect(result).toBeDefined();
    expect(elapsed).toBeLessThan(POLL_INTERVAL);
  });

  it("fileContains with an absent timeout fails immediately for missing content", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "absent-timeout-content.txt");
    writeFileSync(filePath, "wrong content");

    const start = Date.now();
    const result = await fileContains(filePath, "needle");
    const elapsed = Date.now() - start;

    expect(result).toBeDefined();
    expect(elapsed).toBeLessThan(POLL_INTERVAL);
  });

  it("fileContains with timeout 0 still passes immediately when the expected text is already present", async () => {
    const dir = makeTempDir();
    const filePath = join(dir, "already-there-zero-content.txt");
    writeFileSync(filePath, "the marker is right here");

    const result = await fileContains(filePath, "the marker", 0);

    expect(result).toBeUndefined();
  });
});
