/**
 * Per-flow working directory lifecycle for the CLI execution model: a fresh,
 * empty temp directory per flow — removed when the flow passes, kept (with
 * its absolute path available for the failure report) when it fails. The
 * CLI analog of the web surface's failure screenshot.
 *
 * A configured working directory is used as-is and is never removed by
 * dispose, regardless of pass or fail — only a directory this module itself
 * created is ever a candidate for cleanup.
 *
 * Deliberately zero dependencies on the rest of the FlowSpec codebase (takes
 * the configured cwd as a plain `string | undefined`, not a config object),
 * so it can be built and consumed independently of the config/CLI-runner
 * items.
 */

import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface FlowWorkdir {
  /** Absolute path to the directory the flow should run in. */
  path: string;
  /** True when this module created `path` (and so may remove it); false for a configured cwd. */
  isTemp: boolean;
  /**
   * Release the workdir. A temp directory is removed when `passed` is true
   * and left in place when `passed` is false; a configured cwd is never
   * removed either way. Never throws or rejects — a cleanup failure must
   * never mask the flow's own pass/fail result.
   */
  dispose(passed: boolean): Promise<void>;
}

const TEMP_DIR_PREFIX = "flowspec-";

/**
 * Create the working directory a flow will run in.
 *
 * - No `configuredCwd`: creates a fresh, unique, empty temp directory
 *   (prefixed "flowspec-" so a kept one is identifiable) and returns it with
 *   `isTemp: true`.
 * - `configuredCwd` given: used as-is, `isTemp: false`. A relative path is
 *   resolved against `process.cwd()`; an absolute path is passed through
 *   unchanged. Not created and not existence-checked here — the caller is
 *   expected to have supplied a real, usable directory.
 */
export function createFlowWorkdir(configuredCwd?: string): FlowWorkdir {
  if (configuredCwd !== undefined) {
    const path = isAbsolute(configuredCwd)
      ? configuredCwd
      : resolve(process.cwd(), configuredCwd);

    return {
      path,
      isTemp: false,
      dispose: async () => {
        // A configured cwd is never ours to remove, on pass or on fail.
      },
    };
  }

  const path = mkdtempSync(join(tmpdir(), TEMP_DIR_PREFIX));

  return {
    path,
    isTemp: true,
    dispose: async (passed: boolean) => {
      if (!passed) {
        // Keep the directory (and everything written into it) for
        // inspection alongside the failure report.
        return;
      }
      try {
        await rm(path, { recursive: true, force: true });
      } catch {
        // Already gone, or removal was blocked (e.g. permissions) — either
        // way, a cleanup failure must not surface as a dispose() rejection.
      }
    },
  };
}
