import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFlowWorkdir } from "../src/workdir";

/**
 * Tests for WI-804: per-flow working directory lifecycle.
 *
 * Contract pinned by the work item:
 *  - createFlowWorkdir(configuredCwd?: string): { path: string, isTemp: boolean, dispose(passed: boolean): Promise<void> }
 *  - No configuredCwd: a fresh, unique, empty temp directory (isTemp: true).
 *  - dispose(true) (flow passed): removes a temp directory and everything
 *    in it. dispose(false) (flow failed): leaves it in place, and `path`
 *    (already available before disposal) is an absolute path for the
 *    failure report.
 *  - A configured cwd is used AS-IS (isTemp: false) and is NEVER removed
 *    by dispose, on pass or on fail. A relative configured cwd resolves
 *    against process.cwd().
 *  - dispose never throws, even if the directory is already gone or its
 *    removal is blocked — a cleanup failure must never mask the flow's
 *    own pass/fail result.
 */

const trackedDirs: string[] = [];

function track(dir: string): string {
  trackedDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of trackedDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createFlowWorkdir: no configured cwd", () => {
  it("creates a fresh, empty, unique temp directory", () => {
    const a = createFlowWorkdir();
    track(a.path);
    const b = createFlowWorkdir();
    track(b.path);

    expect(a.path).not.toBe(b.path);
    expect(a.isTemp).toBe(true);
    expect(b.isTemp).toBe(true);
    expect(existsSync(a.path)).toBe(true);
    expect(existsSync(b.path)).toBe(true);
    expect(readdirSync(a.path)).toEqual([]);
    expect(readdirSync(b.path)).toEqual([]);
  });

  it("uses a 'flowspec-' prefix so a kept directory is identifiable", () => {
    const workdir = createFlowWorkdir();
    track(workdir.path);
    expect(workdir.path).toContain("flowspec-");
  });

  it("does not let one flow's workdir see another's files", () => {
    const a = createFlowWorkdir();
    track(a.path);
    writeFileSync(join(a.path, "only-in-a.txt"), "a's content");

    const b = createFlowWorkdir();
    track(b.path);

    expect(readdirSync(b.path)).toEqual([]);
    expect(existsSync(join(b.path, "only-in-a.txt"))).toBe(false);
  });
});

describe("dispose: temp workdir lifecycle", () => {
  it("removes the directory and everything written inside it when the flow passed", async () => {
    const workdir = createFlowWorkdir();
    track(workdir.path);
    writeFileSync(join(workdir.path, "output.txt"), "some output");

    await workdir.dispose(true);

    expect(existsSync(workdir.path)).toBe(false);
  });

  it("keeps the directory and its contents when the flow failed, and exposes an absolute path", async () => {
    const workdir = createFlowWorkdir();
    track(workdir.path);
    writeFileSync(join(workdir.path, "output.txt"), "some output");

    await workdir.dispose(false);

    expect(existsSync(workdir.path)).toBe(true);
    expect(existsSync(join(workdir.path, "output.txt"))).toBe(true);
    expect(isAbsolute(workdir.path)).toBe(true);
  });
});

describe("createFlowWorkdir: configured cwd", () => {
  it("uses the configured absolute directory as-is, with isTemp: false", () => {
    const configured = track(
      realpathSync(mkdtempSync(join(tmpdir(), "flowspec-workdir-cwd-"))),
    );
    writeFileSync(join(configured, "pre-existing.txt"), "already here");

    const workdir = createFlowWorkdir(configured);

    expect(workdir.path).toBe(configured);
    expect(workdir.isTemp).toBe(false);
    expect(existsSync(join(workdir.path, "pre-existing.txt"))).toBe(true);
  });

  it("resolves a relative configured cwd against process.cwd()", () => {
    const configured = track(
      realpathSync(mkdtempSync(join(tmpdir(), "flowspec-workdir-cwd-"))),
    );
    const relativeConfigured = relative(process.cwd(), configured);

    const workdir = createFlowWorkdir(relativeConfigured);

    expect(workdir.path).toBe(configured);
  });

  it("never removes a configured cwd directory when the flow passed", async () => {
    const configured = track(
      realpathSync(mkdtempSync(join(tmpdir(), "flowspec-workdir-cwd-"))),
    );
    writeFileSync(join(configured, "pre-existing.txt"), "already here");
    const workdir = createFlowWorkdir(configured);
    writeFileSync(join(workdir.path, "new-output.txt"), "written by flow");

    await workdir.dispose(true);

    expect(existsSync(configured)).toBe(true);
    expect(existsSync(join(configured, "pre-existing.txt"))).toBe(true);
    expect(existsSync(join(configured, "new-output.txt"))).toBe(true);
  });

  it("never removes a configured cwd directory when the flow failed", async () => {
    const configured = track(
      realpathSync(mkdtempSync(join(tmpdir(), "flowspec-workdir-cwd-"))),
    );
    writeFileSync(join(configured, "pre-existing.txt"), "already here");
    const workdir = createFlowWorkdir(configured);

    await workdir.dispose(false);

    expect(existsSync(configured)).toBe(true);
    expect(existsSync(join(configured, "pre-existing.txt"))).toBe(true);
  });
});

describe("dispose: cleanup failures never throw or mask the flow result", () => {
  it("does not throw when the directory was already removed before dispose", async () => {
    const workdir = createFlowWorkdir();
    rmSync(workdir.path, { recursive: true, force: true });

    await expect(workdir.dispose(true)).resolves.toBeUndefined();
  });

  it("does not throw even when directory removal is blocked by permissions (best-effort; safe under root, where removal may still succeed)", async () => {
    const workdir = createFlowWorkdir();
    writeFileSync(join(workdir.path, "locked.txt"), "content");
    // Removing an entry requires write+execute permission on the directory
    // that CONTAINS it. Stripping write from workdir.path itself (not its
    // parent) targets removal of "locked.txt" during the recursive delete,
    // triggering a permission error partway through disposal — without
    // touching the real OS temp directory's own permissions. Under a
    // root-privileged process this restriction has no effect (root bypasses
    // POSIX permission checks) and removal simply succeeds instead; either
    // way, the only thing asserted is that dispose never throws.
    chmodSync(workdir.path, 0o500);

    try {
      await expect(workdir.dispose(true)).resolves.toBeUndefined();
    } finally {
      // Restore permissions unconditionally so afterEach/track-based
      // cleanup (or the OS temp-dir reaper) can still remove it, whether
      // or not dispose itself succeeded at removing it.
      if (existsSync(workdir.path)) {
        chmodSync(workdir.path, 0o700);
        track(workdir.path);
      }
    }
  });
});
