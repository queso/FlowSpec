/**
 * The CLI-surface spawn primitive: runs a command directly from an argv
 * array — never through a shell — and captures its stdout, stderr, and exit
 * code. This is distinct from runner.ts's execCommand, which is purpose-built
 * for driving the agent-browser binary (fixed stdin: "ignore", no cwd/env
 * support) and must stay behaviorally unchanged.
 */

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  /** Milliseconds before the process is killed. Unset means no limit. */
  timeout?: number;
  /** Bytes per stream before truncating. Defaults to DEFAULT_CAPTURE_LIMIT. */
  captureLimit?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when `options.timeout` expired and the process was killed. */
  timedOut: boolean;
  /** True when either stream's captured text was truncated at its limit. */
  truncated: boolean;
}

/**
 * Default ceiling on captured stdout/stderr size. Declared here so both the
 * config layer and the capture-cap enforcement below consume this single
 * named constant rather than restating the literal.
 */
export const DEFAULT_CAPTURE_LIMIT = 5 * 1024 * 1024;

/**
 * Grace period between a timed-out process's SIGTERM and a follow-up
 * SIGKILL, for a child that traps or ignores SIGTERM (verified interactively
 * against Bun 1.3.11: SIGTERM alone left such a child alive 3000ms+ later;
 * Bun does not escalate signals on its own). Not exported/configurable —
 * this is termination hygiene, not a contract surface.
 */
const TIMEOUT_KILL_GRACE_PERIOD_MS = 500;

/**
 * Appended to a stream's captured text when it was cut off at its capture
 * limit — matches src/matchers.ts's own excerpt-truncation marker
 * convention. Duplicated here rather than imported: exec.ts otherwise has no
 * dependency on matchers.ts, and the marker is a stable, trivial literal.
 */
const TRUNCATION_MARKER = "[truncated]";

/**
 * Minimal shape of the pieces of Bun's global spawn API this module uses.
 * Deliberately a local interface accessed via a `globalThis` cast, not a
 * `declare global { var Bun }` ambient augmentation: runner.ts already
 * declares that global with a narrower shape (no cwd/env, fixed stdin
 * modes), and a second, differently-shaped ambient declaration for the same
 * global `var` would conflict under TypeScript's declaration-merging rules.
 * Touching runner.ts's declaration is out of scope for this item.
 */
interface BunFileSink {
  write(chunk: string): number | Promise<number>;
  end(): Promise<number> | number | undefined;
}

interface BunSubprocess {
  stdin: BunFileSink;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: string): void;
}

interface BunSpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdout?: "pipe" | "inherit" | "ignore";
  stderr?: "pipe" | "inherit" | "ignore";
  stdin?: "pipe" | "inherit" | "ignore";
}

interface BunRuntime {
  spawn: (cmd: string[], options?: BunSpawnOptions) => BunSubprocess;
}

function getBunRuntime(): BunRuntime | undefined {
  return (globalThis as unknown as { Bun?: BunRuntime }).Bun;
}

interface BoundedRead {
  text: string;
  truncated: boolean;
}

/**
 * Read `stream` to completion, decoded as UTF-8, capturing at most `limit`
 * bytes. The stream is drained in full regardless of the limit — bytes past
 * it are counted but discarded, never buffered — so a runaway writer can
 * never block on pipe backpressure waiting for a reader that stopped
 * consuming. This is the enforcement point for the "streaming, not
 * capture-then-slice" requirement: memory use is bounded by `limit`
 * throughout the read, not just in the final result.
 */
async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<BoundedRead> {
  const reader = stream.getReader();
  const capturedChunks: Uint8Array[] = [];
  let capturedBytes = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.length === 0) {
        continue;
      }

      const remaining = limit - capturedBytes;
      if (remaining <= 0) {
        truncated = true;
        continue;
      }
      if (value.length > remaining) {
        capturedChunks.push(value.subarray(0, remaining));
        capturedBytes += remaining;
        truncated = true;
      } else {
        capturedChunks.push(value);
        capturedBytes += value.length;
      }
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = new Uint8Array(capturedBytes);
  let offset = 0;
  for (const chunk of capturedChunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }

  return { text: new TextDecoder("utf-8").decode(buffer), truncated };
}

/**
 * Spawn `argv[0]` with `argv.slice(1)` as arguments, via Bun's native spawn
 * (falling back to Node's execFileSync when Bun isn't the runtime).
 *
 * `options.env` OVERLAYS the inherited environment: Bun.spawn's own `env`
 * option replaces the environment wholesale when provided, so it is merged
 * with `process.env` here — an explicit entry wins over an inherited one of
 * the same name, and everything else inherited stays visible to the child.
 *
 * `options.stdin`, when given, is written to the child and the stream is
 * then closed. Writing to a child that has already exited throws
 * synchronously (EPIPE); that write failure is swallowed — it reflects a
 * reader that was never there, not a problem with the command's own result —
 * and the real exit code is still awaited and reported.
 *
 * A command that cannot be spawned at all (e.g. not found) rejects: this is
 * simply Bun.spawn's own synchronous throw (naming the executable)
 * propagating out of this async function un-caught, rather than being
 * papered over as an artificial exit code.
 *
 * `options.timeout`, when set, kills the process once it expires rather than
 * letting the run hang: Bun's `.kill()` still lets `proc.exited` resolve
 * (observed exit code 143) and the stdout/stderr streams still yield
 * whatever was written before the kill — nothing here needs to race against
 * a hang. `options.captureLimit` (default DEFAULT_CAPTURE_LIMIT) bounds each
 * stream independently; a stream that hits its limit is truncated with an
 * explicit marker and reported via `truncated: true`.
 */
export async function spawnProcess(
  argv: string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  const bun = getBunRuntime();

  if (bun) {
    return spawnWithBun(bun, argv, options);
  }

  return spawnWithNode(argv, options);
}

async function spawnWithBun(
  bun: BunRuntime,
  argv: string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  const hasStdin = options?.stdin !== undefined;
  const captureLimit = options?.captureLimit ?? DEFAULT_CAPTURE_LIMIT;

  const proc = bun.spawn(argv, {
    cwd: options?.cwd,
    // process.env's values may be `string | undefined`; every value that
    // actually exists at runtime is a string, so this overlay is cast back
    // to Record<string, string> for BunSpawnOptions.
    env: { ...process.env, ...options?.env } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
    stdin: hasStdin ? "pipe" : "ignore",
  });

  if (hasStdin) {
    try {
      // Bun's FileSink write()/end() can reject (rather than throw
      // synchronously) when the underlying pipe is already broken — e.g. a
      // large payload written to a child that exited before reading it. Both
      // calls must be awaited so that rejection lands in this try/catch
      // instead of surfacing as an unhandled promise rejection.
      await proc.stdin.write(options?.stdin as string);
      await proc.stdin.end();
    } catch {
      // The child may have already exited without reading stdin (EPIPE).
      // Not a failure of spawnProcess — the real exit code below still
      // gets reported.
    }
  }

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  if (typeof options?.timeout === "number") {
    timer = setTimeout(() => {
      timedOut = true;
      // A bare SIGTERM is not a guarantee: Bun does not escalate to SIGKILL
      // on its own, so a child that traps or ignores SIGTERM would
      // otherwise hang here until it exits on some unrelated schedule —
      // defeating the entire point of a timeout. SIGTERM first (so a
      // well-behaved child still gets a chance to shut down cleanly), then
      // a hard SIGKILL if it hasn't actually exited after a short grace
      // period. `proc.exited` resolving cancels the grace timer below
      // before it ever fires for the common (compliant-child) case.
      proc.kill();
      graceTimer = setTimeout(() => {
        proc.kill("SIGKILL");
      }, TIMEOUT_KILL_GRACE_PERIOD_MS);
    }, options.timeout);
  }

  const [stdoutResult, stderrResult, exitCode] = await Promise.all([
    readBoundedStream(proc.stdout, captureLimit),
    readBoundedStream(proc.stderr, captureLimit),
    proc.exited,
  ]);

  if (timer) {
    clearTimeout(timer);
  }
  if (graceTimer) {
    clearTimeout(graceTimer);
  }

  const stdout = stdoutResult.truncated
    ? stdoutResult.text + TRUNCATION_MARKER
    : stdoutResult.text;
  let stderr = stderrResult.truncated
    ? stderrResult.text + TRUNCATION_MARKER
    : stderrResult.text;

  if (timedOut) {
    stderr += `\n[timed out after ${options?.timeout}ms]`;
  }

  return {
    stdout,
    stderr,
    exitCode,
    timedOut,
    truncated: stdoutResult.truncated || stderrResult.truncated,
  };
}

/**
 * Node fallback, mirroring the execFileSync-based pattern in runner.ts's
 * execCommand. Best-effort only: the project's whole test suite runs under
 * Bun, so no test exercises this branch — it honors the same contract by
 * inspection, but coverage is not claimed for it anywhere.
 *
 * `execFileSync`'s `timeout`/`maxBuffer` are the closest Node primitives to
 * this contract, but they don't match it exactly: both cause a *throw*
 * (never a graceful resolve), and there is no guarantee of exactly-truncated
 * (rather than fully-discarded) partial output on a maxBuffer overflow —
 * this fallback maps their errors onto `timedOut`/`truncated` as best it
 * can, but a caller relying on the Node path should not expect the same
 * precision (exact byte-bounded truncation, guaranteed partial capture on
 * timeout) that the Bun path guarantees and this item's tests verify.
 */
async function spawnWithNode(
  argv: string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  const { execFileSync } = await import("node:child_process");
  const [command, ...args] = argv;
  const captureLimit = options?.captureLimit ?? DEFAULT_CAPTURE_LIMIT;

  try {
    const stdout = execFileSync(command, args, {
      encoding: "utf-8",
      cwd: options?.cwd,
      env: { ...process.env, ...options?.env },
      input: options?.stdin,
      timeout: options?.timeout,
      maxBuffer: captureLimit,
    });
    return {
      stdout,
      stderr: "",
      exitCode: 0,
      timedOut: false,
      truncated: false,
    };
  } catch (error: unknown) {
    const execError = error as {
      stderr?: Buffer | string;
      stdout?: Buffer | string;
      status?: number | null;
      code?: string;
      killed?: boolean;
      signal?: string | null;
    };

    const timedOut =
      execError.killed === true &&
      typeof options?.timeout === "number" &&
      execError.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
    const truncated = execError.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

    // A genuine spawn failure (command not found) throws with no exit status
    // and isn't a timeout/maxBuffer kill — propagate it rather than
    // resolving with a synthetic result, matching the Bun branch's
    // reject-on-spawn-failure contract.
    if (execError.status == null && !timedOut && !truncated) {
      throw error;
    }

    const stderr =
      typeof execError.stderr === "string"
        ? execError.stderr
        : (execError.stderr?.toString() ?? "");
    const stdout =
      typeof execError.stdout === "string"
        ? execError.stdout
        : (execError.stdout?.toString() ?? "");

    return {
      stdout,
      stderr: timedOut
        ? `${stderr}\n[timed out after ${options?.timeout}ms]`
        : stderr,
      exitCode: execError.status ?? (timedOut || truncated ? 1 : 0),
      timedOut,
      truncated,
    };
  }
}
