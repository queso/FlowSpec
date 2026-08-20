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

import { resolve, sep } from "node:path";
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

interface LastStepResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

type ResolvedPath =
  | { ok: true; absolutePath: string }
  | { ok: false; message: string };

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
 */
function resolveWithinWorkdir(
  requestedPath: string,
  workdir: string,
): ResolvedPath {
  const root = resolve(workdir);
  const absolutePath = resolve(root, requestedPath);

  // A root that is already a filesystem root ("/", "C:\\") ends in the
  // separator; appending another would produce "//" and reject everything.
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  const isInside = absolutePath === root || absolutePath.startsWith(prefix);
  if (!isInside) {
    return {
      ok: false,
      message: `File path "${requestedPath}" resolves to ${absolutePath}, which is outside the flow working directory ${root}`,
    };
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

  if ("stdout_contains" in assertion) {
    const failure = matchContains(lastStep.stdout, assertion.stdout_contains);
    return failure ? toFailure(failure.message, lastStep, workdir) : undefined;
  }

  if ("stderr_contains" in assertion) {
    const failure = matchContains(lastStep.stderr, assertion.stderr_contains);
    return failure ? toFailure(failure.message, lastStep, workdir) : undefined;
  }

  if ("stdout_matches" in assertion) {
    const failure = matchRegex(lastStep.stdout, assertion.stdout_matches);
    return failure ? toFailure(failure.message, lastStep, workdir) : undefined;
  }

  if ("stderr_matches" in assertion) {
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
