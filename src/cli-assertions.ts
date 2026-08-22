/**
 * The CLI assertion dispatcher: evaluates one of the eight CLI assertions
 * (src/types.ts's CliAssertion) against a completed run step's captured
 * result. Deliberately decoupled from the CLI runner — this module takes a
 * plain last-step result, a working directory, and a timeout, and does not
 * import src/cli-runner.ts — so it can be built independently and reused.
 *
 * All real matching is delegated to the shared primitives: substring/regex/
 * dot-path-JSON from src/matchers.ts, and the polling file checks from
 * src/file-matchers.ts. This module's own job is purely dispatch (which of
 * the eight assertion keys is present) and assembling a uniform failure
 * shape — it never reimplements matching logic inline.
 *
 * Per the PRD's retry split: exit_code, stdout/stderr contains/matches, and
 * json_output all evaluate exactly once (an already-captured stream cannot
 * change). file_exists/file_contains retry within `timeout`, because an
 * async writer can still change the answer.
 */

import { realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileContains, fileExists } from "./file-matchers.js";
import {
  boundedExcerpt,
  matchContains,
  matchJsonPath,
  matchRegex,
} from "./matchers.js";
import type { CliAssertion } from "./types.js";

export interface CliAssertionFailure {
  message: string;
  /** The last run step's exit code — always attached, regardless of which assertion failed. */
  exitCode: number;
  /** The last run step's stdout, bounded to EXCERPT_LIMIT. */
  stdout: string;
  /** The last run step's stderr, bounded to EXCERPT_LIMIT. */
  stderr: string;
  /** Passed straight through from the caller. */
  workdir: string;
}

export interface LastStepResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

type ResolvedPath =
  | { ok: true; absolutePath: string }
  | { ok: false; message: string };

/**
 * Resolve the real, symlink-free path of the deepest ancestor of
 * `absolutePath` that currently exists on disk, walking upward one path
 * component at a time until something resolves (or the filesystem root is
 * reached without finding anything).
 *
 * This exists to defend against symlink traversal WITHOUT breaking
 * file_exists/file_contains's retry-for-a-not-yet-created-file contract
 * (see src/file-matchers.ts's pollUntilPass): those two assertions poll
 * while an async writer may still be creating the target file, and
 * `realpathSync` throws ENOENT on a path that doesn't exist yet. Naively
 * realpathing the full requested path would turn every "waiting for the
 * file to appear" check into an immediate hard failure.
 *
 * The insight that makes walking up to the deepest EXISTING ancestor
 * sufficient: a symlink is itself a filesystem entry, so a path component
 * that doesn't exist yet cannot itself be a symlink. Once the deepest
 * existing ancestor's real path is confirmed to stay inside the workdir,
 * every remaining (not-yet-existing) trailing component is a plain, inert
 * path segment — there is nothing further for a symlink to hijack.
 */
function realpathDeepestExisting(absolutePath: string): string {
  let current = absolutePath;
  for (;;) {
    try {
      return realpathSync(current);
    } catch (error) {
      const parent = dirname(current);
      const isMissing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
      if (!isMissing || parent === current) {
        // Either a non-ENOENT error (permissions, a path component that
        // turned out not to be a directory, etc.) or we've walked all the
        // way to a filesystem root without resolving anything. Return the
        // unresolved path as-is rather than looping forever or throwing —
        // the containment check downstream fails closed against it if it
        // doesn't match the (already-realpath'd) workdir root.
        return current;
      }
      current = parent;
    }
  }
}

/**
 * realpathSync the workdir root itself, falling back to the plain resolved
 * path if that fails (the workdir should always exist by the time an
 * assertion runs, but this avoids a hard crash over a defensive edge case).
 * This matters on macOS, where `/tmp` is itself a symlink to `/private/tmp`
 * — without realpath'ing the root too, a workdir created via
 * `mkdtempSync(tmpdir())` would never compare equal to its own
 * realpath'd descendants (see test/dogfood-plumbing.test.ts, which
 * realpathSync's its temp dir for the same reason).
 */
function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Resolve a file-assertion path against `workdir` and confine it there.
 *
 * The per-flow temp working directory is the whole point of CLI isolation,
 * so a path that resolves outside it — an absolute path like "/etc/passwd",
 * or a "../" traversal — is rejected as out-of-bounds rather than answered
 * by whatever happens to exist elsewhere on disk. Without this, such an
 * assertion silently PASSES (a wrong green, not an exploit: specs are
 * user-authored) and says nothing about the flow's own output.
 *
 * The containment check compares fully resolved absolute paths and requires
 * either an exact match or a separator-terminated prefix, so a sibling
 * directory whose name merely starts with the workdir's name
 * ("/tmp/wd-extra" against "/tmp/wd") is correctly treated as outside.
 *
 * That string-prefix check alone is not enough, though: it operates on the
 * syntactically resolved path (node:path's `resolve`, which normalizes
 * "../" segments but never touches the filesystem) and so does not account
 * for symlinks. A symlink living INSIDE the workdir that points outside it
 * (e.g. requesting "linked/secret.txt" where "linked" is a symlink to
 * /etc) resolves, post-symlink, to somewhere the prefix check never sees —
 * it would wrongly report that path as contained. So containment is
 * checked a second time against the REAL (symlink-resolved) path of the
 * deepest existing ancestor, per realpathDeepestExisting above.
 */
function resolveWithinWorkdir(
  requestedPath: string,
  workdir: string,
): ResolvedPath {
  const root = safeRealpath(resolve(workdir));
  const absolutePath = resolve(root, requestedPath);

  // A root that is already a filesystem root ("/", "C:\\") ends in the
  // separator; appending another would produce "//" and reject everything.
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  const isInside = (candidate: string) =>
    candidate === root || candidate.startsWith(prefix);

  const outOfBounds: ResolvedPath = {
    ok: false,
    message: `File path "${requestedPath}" resolves to ${absolutePath}, which is outside the flow working directory ${root}`,
  };

  if (!isInside(absolutePath)) {
    return outOfBounds;
  }

  const realAncestor = realpathDeepestExisting(absolutePath);
  if (!isInside(realAncestor)) {
    return outOfBounds;
  }

  return { ok: true, absolutePath };
}

/**
 * Assemble a CliAssertionFailure from a raw message: the last step's
 * exitCode/stdout/stderr and the caller's workdir are attached uniformly,
 * regardless of which assertion produced the message.
 */
function toFailure(
  message: string,
  lastStep: LastStepResult,
  workdir: string,
): CliAssertionFailure {
  return {
    message,
    exitCode: lastStep.exitCode,
    stdout: boundedExcerpt(lastStep.stdout),
    stderr: boundedExcerpt(lastStep.stderr),
    workdir,
  };
}

/**
 * Evaluate `assertion` against `lastStep`'s captured output (and, for the
 * two file assertions, the filesystem under `workdir`). Returns `undefined`
 * on pass, or a CliAssertionFailure naming the specific problem.
 *
 * This deliberately does NOT return a full FlowError — it does not set
 * FlowErrorSchema's `assertion` field (still typed web-only/StepAssertion,
 * unchanged by WI-805). Assembling a full FlowError (adding `step`, `phase`,
 * etc.) is the CLI runner's job, one layer up.
 */
export async function evaluateCliAssertion(
  assertion: CliAssertion,
  lastStep: LastStepResult,
  workdir: string,
  timeout: number,
): Promise<CliAssertionFailure | undefined> {
  if ("exit_code" in assertion) {
    if (lastStep.exitCode === assertion.exit_code) {
      return undefined;
    }
    return toFailure(
      `Expected exit code ${assertion.exit_code} but got ${lastStep.exitCode}`,
      lastStep,
      workdir,
    );
  }

  // The four stream branches below guard explicitly against a missing
  // value, for the same reason file_contains/json_output do (see their
  // comments): a schema-validated CliAssertion always has the verb's value
  // present as a non-empty string, but this function is also reachable
  // directly by a caller that bypassed validation. Left unguarded,
  // `haystack.includes(undefined)` coerces to `haystack.includes("undefined")`
  // and `new RegExp(undefined)` compiles to `/(?:)/`, which matches every
  // string — both would let a never-specified assertion silently PASS
  // rather than fail with a clear "missing" message.

  if ("stdout_contains" in assertion) {
    if (typeof assertion.stdout_contains !== "string") {
      return toFailure('Missing "stdout_contains" text', lastStep, workdir);
    }
    const failure = matchContains(lastStep.stdout, assertion.stdout_contains);
    return failure ? toFailure(failure.message, lastStep, workdir) : undefined;
  }

  if ("stderr_contains" in assertion) {
    if (typeof assertion.stderr_contains !== "string") {
      return toFailure('Missing "stderr_contains" text', lastStep, workdir);
    }
    const failure = matchContains(lastStep.stderr, assertion.stderr_contains);
    return failure ? toFailure(failure.message, lastStep, workdir) : undefined;
  }

  if ("stdout_matches" in assertion) {
    if (typeof assertion.stdout_matches !== "string") {
      return toFailure('Missing "stdout_matches" pattern', lastStep, workdir);
    }
    const failure = matchRegex(lastStep.stdout, assertion.stdout_matches);
    return failure ? toFailure(failure.message, lastStep, workdir) : undefined;
  }

  if ("stderr_matches" in assertion) {
    if (typeof assertion.stderr_matches !== "string") {
      return toFailure('Missing "stderr_matches" pattern', lastStep, workdir);
    }
    const failure = matchRegex(lastStep.stderr, assertion.stderr_matches);
    return failure ? toFailure(failure.message, lastStep, workdir) : undefined;
  }

  if ("json_output" in assertion) {
    // `path`/`equals` are typed optional on CliAssertion because
    // src/types.ts enforces their presence via a superRefine (rather than a
    // bare required field, so a missing key can be named instead of a
    // generic "Required" message) — a schema-validated CliAssertion always
    // has `path` set. But this function is also reachable directly (as this
    // item's dispatch wiring does, and as a caller bypassing schema
    // validation could), so `path` is guarded explicitly rather than
    // trusted: without this, `matchJsonPath` crashes with
    // "path.startsWith is not a function" on a missing path, even against
    // otherwise-valid JSON stdout (verified interactively).
    const { path, equals } = assertion.json_output;
    if (path === undefined) {
      return toFailure('Missing "path" in json_output', lastStep, workdir);
    }
    const failure = matchJsonPath(lastStep.stdout, path, equals);
    return failure ? toFailure(failure.message, lastStep, workdir) : undefined;
  }

  if ("file_exists" in assertion) {
    const resolved = resolveWithinWorkdir(assertion.file_exists, workdir);
    if (!resolved.ok) {
      return toFailure(resolved.message, lastStep, workdir);
    }
    const failure = await fileExists(resolved.absolutePath, timeout);
    return failure ? toFailure(failure.message, lastStep, workdir) : undefined;
  }

  if ("file_contains" in assertion) {
    // Same reasoning as json_output's `path` guard above, plus a second,
    // more insidious case: an unguarded `text: undefined` doesn't crash —
    // `content.includes(undefined)` coerces to `content.includes("undefined")`,
    // so a file whose content genuinely contains the literal word
    // "undefined" would silently PASS an assertion that never specified
    // real text to look for. Both are guarded explicitly rather than
    // trusted, verified interactively before writing this.
    const { path, text } = assertion.file_contains;
    if (path === undefined) {
      return toFailure('Missing "path" in file_contains', lastStep, workdir);
    }
    if (text === undefined) {
      return toFailure('Missing "text" in file_contains', lastStep, workdir);
    }
    const resolved = resolveWithinWorkdir(path, workdir);
    if (!resolved.ok) {
      return toFailure(resolved.message, lastStep, workdir);
    }
    const failure = await fileContains(resolved.absolutePath, text, timeout);
    return failure ? toFailure(failure.message, lastStep, workdir) : undefined;
  }

  // No recognized CLI assertion key matched. A schema-validated CliAssertion
  // can never reach here, but this function is reachable directly by a
  // caller that bypassed validation (as a defensive guard, not a case this
  // item's own dispatch wiring exercises) — without this, the code used to
  // fall through unconditionally into the file_contains branch above and
  // crash on `assertion.file_contains` being undefined.
  return toFailure("Unrecognized CLI assertion shape", lastStep, workdir);
}
