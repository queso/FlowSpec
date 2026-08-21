import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getAgentBrowserPath } from "../src/runner.js";

/**
 * Regression tests for #15: flowspec hardcoded its own nested
 * node_modules/.bin path, which doesn't exist under hoisting package
 * managers (bun, npm) — so every flow failed at step 0 when flowspec was
 * installed as a dependency.
 */
describe("getAgentBrowserPath", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    // realpath so expectations match module resolution, which returns
    // resolved paths (macOS tmpdir lives behind a /var → /private/var symlink)
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "flowspec-abr-")));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Lay out <root>/node_modules/agent-browser with a bin script. */
  function scaffoldPackage(root: string, { withShim }: { withShim: boolean }) {
    const pkgDir = join(root, "node_modules", "agent-browser");
    mkdirSync(join(pkgDir, "bin"), { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "agent-browser",
        version: "0.0.0-test",
        bin: { "agent-browser": "./bin/agent-browser.js" },
      }),
    );
    writeFileSync(
      join(pkgDir, "bin", "agent-browser.js"),
      "#!/usr/bin/env node\n",
    );
    if (withShim) {
      const binDir = join(root, "node_modules", ".bin");
      mkdirSync(binDir, { recursive: true });
      symlinkSync(
        join("..", "agent-browser", "bin", "agent-browser.js"),
        join(binDir, "agent-browser"),
      );
    }
    // The module URL resolution starts from — a file at the consumer root,
    // as if flowspec code were running from <root>/node_modules/flowspec/.
    return pathToFileURL(join(root, "entry.js")).href;
  }

  it("resolves via the real install in this repo", () => {
    const result = getAgentBrowserPath();
    expect(result).not.toBe("agent-browser");
    expect(result).toContain("agent-browser");
  });

  it("prefers the .bin shim beside the resolved package (hoisted layout)", () => {
    const root = makeTmpDir();
    const fromUrl = scaffoldPackage(root, { withShim: true });
    expect(getAgentBrowserPath(fromUrl)).toBe(
      join(root, "node_modules", ".bin", "agent-browser"),
    );
  });

  it("falls back to the package's own bin script when no shim exists", () => {
    const root = makeTmpDir();
    const fromUrl = scaffoldPackage(root, { withShim: false });
    expect(getAgentBrowserPath(fromUrl)).toBe(
      join(root, "node_modules", "agent-browser", "bin", "agent-browser.js"),
    );
  });

  it("falls back to PATH lookup when agent-browser is not resolvable", () => {
    const root = makeTmpDir();
    const fromUrl = pathToFileURL(join(root, "entry.js")).href;
    expect(getAgentBrowserPath(fromUrl)).toBe("agent-browser");
  });
});
