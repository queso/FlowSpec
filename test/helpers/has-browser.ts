import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Check whether Playwright Chromium binaries are actually installed
 * by looking in the well-known cache directory.
 *
 * This avoids spawning a process (which hangs when binaries are missing)
 * and instead does a fast filesystem check.
 */
export function hasBrowserBinaries(): boolean {
  const home = homedir();
  const cacheDir =
    process.platform === "darwin"
      ? join(home, "Library", "Caches", "ms-playwright")
      : join(home, ".cache", "ms-playwright");

  return existsSync(cacheDir);
}
