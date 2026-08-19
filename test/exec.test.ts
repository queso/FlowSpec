import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CAPTURE_LIMIT, spawnProcess } from "../src/exec";

/**
 * Tests for WI-801: the CLI-surface spawn primitive.
 *
 * Contract pinned by the work item:
 *  - spawnProcess(argv, options?) spawns argv[0] directly with argv.slice(1)
 *    as arguments — NO shell — capturing stdout/stderr/exitCode.
 *  - options.cwd, options.env, options.stdin are all optional.
 *  - options.env OVERLAYS the inherited process.env (both stay visible; an
 *    explicit entry wins over an inherited one of the same name).
 *  - A command that cannot be spawned at all (e.g. not found) REJECTS the
 *    returned promise with an error naming the command — distinct from a
 *    command that runs and exits nonzero, which RESOLVES normally.
 *  - Writing stdin to a process that never reads it must not reject or
 *    throw out of spawnProcess; the real exit code is still reported.
 *  - ExecResult always carries `timedOut` and `truncated`, both false in
 *    this item (a follow-up item gives them real meaning).
 *  - DEFAULT_CAPTURE_LIMIT is exported as 5 * 1024 * 1024.
 *
 * Fixture note: commands are `process.execPath -e <script>` (this suite
 * runs under Bun, so `process.execPath` is the real `bun` binary and `-e`
 * runs inline JS) rather than assuming an external `node` binary exists —
 * verified interactively against Bun 1.3.11's actual Bun.spawn semantics
 * (env replaces rather than merges unless the implementation merges it
 * manually; stdin.write() throws synchronously as EPIPE against an
 * already-exited child; a missing executable throws synchronously from
 * Bun.spawn itself, naming the executable) before these tests were written.
 */

// bun:test's `vi` shim (what "vitest" aliases to under Bun per CLAUDE.md)
// does not implement vi.stubEnv/vi.unstubAllEnvs — verified directly
// (Object.keys(vi) has no stubEnv/unstubAllEnvs entries under Bun 1.3.11).
// Save and restore process.env manually instead, so a test that sets an
// env var for a spawned child never leaks it into a later test.
const ENV_SNAPSHOT = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ENV_SNAPSHOT)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, ENV_SNAPSHOT);
});

const PRINT_LAST_ARG = "process.stdout.write(process.argv.at(-1))";
const PRINT_CWD = "process.stdout.write(process.cwd())";
const PRINT_ENV = (name: string) =>
  `process.stdout.write(process.env.${name} ?? '')`;
const READ_STDIN_TO_STDOUT = [
  "let d = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (c) => { d += c; });",
  "process.stdin.on('end', () => { process.stdout.write(d); });",
].join(" ");

describe("spawnProcess: basic capture", () => {
  it("captures stdout, stderr, and a zero exit code for a simple command", async () => {
    const result = await spawnProcess([
      process.execPath,
      "-e",
      "process.stdout.write('hi')",
    ]);
    expect(result.stdout).toBe("hi");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("resolves (does not reject) when the command runs but exits nonzero", async () => {
    const result = await spawnProcess([
      process.execPath,
      "-e",
      "process.exit(7)",
    ]);
    expect(result.exitCode).toBe(7);
  });

  it("always reports timedOut: false and truncated: false in this item", async () => {
    const result = await spawnProcess([
      process.execPath,
      "-e",
      "process.stdout.write('ok')",
    ]);
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
  });
});

describe("spawnProcess: no shell, ever", () => {
  it.each([
    ["command substitution", "$(whoami)"],
    ["backtick substitution", "`whoami`"],
    ["command chaining with &&", "true && echo should-not-run-separately"],
    ["pipe", "echo hi | cat"],
    ["semicolon chaining", "echo hi; echo bye"],
    ["redirect", "echo hi > /tmp/flowspec-exec-test-should-not-exist"],
    ["environment variable expansion", "$HOME"],
    ["glob", "*.ts"],
    ["embedded double quotes", 'say "hello"'],
    ["embedded single quotes", "say 'hello'"],
  ])("passes an argument containing %s through to the child as literal, unexpanded characters", async (_label, raw) => {
    const result = await spawnProcess([
      process.execPath,
      "-e",
      PRINT_LAST_ARG,
      raw,
    ]);
    expect(result.stdout).toBe(raw);
    expect(result.exitCode).toBe(0);
  });

  it("does not execute a chained command even when the argument looks like a full shell command line", async () => {
    const marker = join(
      tmpdir(),
      `flowspec-exec-no-shell-marker-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    rmSync(marker, { force: true });
    try {
      const chainedLookingArg = `true && touch ${marker}`;
      const result = await spawnProcess([
        process.execPath,
        "-e",
        PRINT_LAST_ARG,
        chainedLookingArg,
      ]);
      expect(result.stdout).toBe(chainedLookingArg);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(marker, { force: true });
    }
  });
});

describe("spawnProcess: cwd option", () => {
  it("honors an absolute cwd: the child reports the supplied directory", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "flowspec-exec-cwd-")));
    try {
      const result = await spawnProcess([process.execPath, "-e", PRINT_CWD], {
        cwd: dir,
      });
      expect(result.stdout).toBe(dir);
      expect(result.stdout).not.toBe(realpathSync(process.cwd()));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves a relative cwd against the FlowSpec process's own cwd", async () => {
    const result = await spawnProcess([process.execPath, "-e", PRINT_CWD], {
      cwd: ".",
    });
    expect(result.stdout).toBe(realpathSync(process.cwd()));
  });

  it("defaults to the FlowSpec process's own cwd when cwd is omitted", async () => {
    const result = await spawnProcess([process.execPath, "-e", PRINT_CWD]);
    expect(result.stdout).toBe(realpathSync(process.cwd()));
  });
});

describe("spawnProcess: env option", () => {
  it("makes a variable supplied in env visible to the child", async () => {
    const result = await spawnProcess(
      [process.execPath, "-e", PRINT_ENV("FLOWSPEC_EXEC_TEST_VAR")],
      { env: { FLOWSPEC_EXEC_TEST_VAR: "hello-from-env" } },
    );
    expect(result.stdout).toBe("hello-from-env");
  });

  it("keeps a variable present only in process.env visible to the child (overlay, not replace)", async () => {
    process.env.FLOWSPEC_EXEC_INHERITED_VAR = "inherited-value";
    const result = await spawnProcess(
      [process.execPath, "-e", PRINT_ENV("FLOWSPEC_EXEC_INHERITED_VAR")],
      { env: { FLOWSPEC_EXEC_TEST_VAR: "hello-from-env" } },
    );
    expect(result.stdout).toBe("inherited-value");
  });

  it("lets an explicit env entry override an inherited variable of the same name", async () => {
    process.env.FLOWSPEC_EXEC_OVERRIDE_VAR = "inherited";
    const result = await spawnProcess(
      [process.execPath, "-e", PRINT_ENV("FLOWSPEC_EXEC_OVERRIDE_VAR")],
      { env: { FLOWSPEC_EXEC_OVERRIDE_VAR: "overridden" } },
    );
    expect(result.stdout).toBe("overridden");
  });

  it("passes an env value containing spaces and shell metacharacters through literally", async () => {
    const value = 'hello world && $(whoami) | "quoted"';
    const result = await spawnProcess(
      [process.execPath, "-e", PRINT_ENV("FLOWSPEC_EXEC_METACHAR_VAR")],
      { env: { FLOWSPEC_EXEC_METACHAR_VAR: value } },
    );
    expect(result.stdout).toBe(value);
  });
});

describe("spawnProcess: stdin option", () => {
  it("writes the stdin string to the child and closes the stream, so a whole-input-reading command receives exactly that string", async () => {
    const input = "hello from flowspec\nwith a newline\n";
    const result = await spawnProcess(
      [process.execPath, "-e", READ_STDIN_TO_STDOUT],
      { stdin: input },
    );
    expect(result.stdout).toBe(input);
    expect(result.exitCode).toBe(0);
  });

  it("does not reject when stdin is written to a command that exits without reading it (EPIPE swallowed), and still reports the child's real exit code", async () => {
    const result = await spawnProcess(
      [process.execPath, "-e", "process.exit(3)"],
      { stdin: "x".repeat(1_000_000) },
    );
    expect(result.exitCode).toBe(3);
  });
});

describe("spawnProcess: spawn failure vs nonzero exit", () => {
  it("rejects with a dedicated error naming the command when the command does not exist", async () => {
    const missingCommand = "flowspec-definitely-not-a-real-binary-xyz";
    await expect(spawnProcess([missingCommand, "--flag"])).rejects.toThrow(
      new RegExp(missingCommand),
    );
  });

  it("does not resolve a missing command as exitCode 1 with empty output", async () => {
    const missingCommand = "flowspec-definitely-not-a-real-binary-xyz";
    let resolved: unknown;
    let rejected = false;
    try {
      resolved = await spawnProcess([missingCommand]);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(resolved).toBeUndefined();
  });
});

describe("DEFAULT_CAPTURE_LIMIT", () => {
  it("is exported as 5 MiB (5 * 1024 * 1024)", () => {
    expect(DEFAULT_CAPTURE_LIMIT).toBe(5 * 1024 * 1024);
  });
});
