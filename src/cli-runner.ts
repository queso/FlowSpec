/**
 * The CLI execution core: runs a `surface: cli` flow's `run` steps, in
 * declaration order, inside the flow's own working directory, applying the
 * PRD's fail-fast exit-code contract — a non-final step fails the flow the
 * moment its exit code isn't what was expected, while the final step's exit
 * code is pure assertion territory (an error-path spec, e.g. "this command
 * should fail", is a first-class flow, not a broken one).
 *
 * Five phases, in order:
 *   1. Create the working directory (src/workdir.ts).
 *   2. Setup phase — a flow-level setup block of CLI steps, run before the
 *      flow's own steps in the same working directory; failures are
 *      `phase: "setup"` with a local index into the setup array.
 *   3. Steps phase — the flow's own run steps, applying the fail-fast
 *      exit-code contract described above.
 *   4. Assertion phase — evaluates `flow.expect` in order against the last
 *      step's captured result via src/cli-assertions.ts's
 *      evaluateCliAssertion, stopping at the first failure.
 *   5. Dispose the working directory, keyed on whether the flow passed.
 *
 * Only the LAST run step's result is kept available past its own iteration
 * — intermediate steps' output is deliberately unaddressable in v1.
 */

import { evaluateCliAssertion } from "./cli-assertions.js";
import { spawnProcess } from "./exec.js";
import type {
  CliAssertion,
  CliStep,
  FlowError,
  FlowResult,
  FlowSpec,
} from "./types.js";
import { createFlowWorkdir } from "./workdir.js";

export interface CliRunOptions {
  cwd?: string;
  timeout?: number;
  captureLimit?: number;
}

/**
 * Build the argv for a run step. Array form passes through element for
 * element, untouched. String form is split on whitespace only — never
 * shell-parsed: no quote stripping, no metacharacter handling. A quoted
 * substring is NOT reassembled into one argv element; the array form is the
 * documented escape hatch for arguments containing spaces.
 */
function buildArgv(run: string | string[]): string[] {
  if (Array.isArray(run)) {
    return run;
  }
  return run.split(/\s+/).filter((token) => token.length > 0);
}

/** Build the CLI FlowError fields (WI-805's shape) shared by every step-phase failure. */
function stepFailure(
  message: string,
  step: CliStep,
  index: number,
  workdir: string,
  execResult?: { exitCode: number; stdout: string; stderr: string },
  phase?: "setup",
): FlowError {
  return {
    message,
    step: index,
    action: step,
    workdir,
    phase,
    ...(execResult
      ? {
          exitCode: execResult.exitCode,
          stdout: execResult.stdout,
          stderr: execResult.stderr,
        }
      : {}),
  };
}

type StepOutcome =
  | {
      ok: true;
      execResult: { exitCode: number; stdout: string; stderr: string };
    }
  | { ok: false; error: FlowError };

/**
 * Spawn one step (a flow step or a setup step — same grammar, same exec
 * primitive) and apply the exit-code contract. `exitCodeIsFatal` is decided
 * by the caller: the steps phase passes `false` only for a final step with
 * no `expect_exit` (assertion territory); the setup phase always passes
 * `true` — setup has no assertion phase of its own, so every setup step,
 * including the last, uses the non-final rule.
 */
async function executeStep(
  step: CliStep,
  index: number,
  workdirPath: string,
  options: CliRunOptions | undefined,
  exitCodeIsFatal: boolean,
  phase?: "setup",
): Promise<StepOutcome> {
  const label = phase === "setup" ? "Setup step" : "Step";
  const argv = buildArgv(step.run);

  let execResult: Awaited<ReturnType<typeof spawnProcess>>;
  try {
    execResult = await spawnProcess(argv, {
      cwd: workdirPath,
      env: step.env,
      stdin: step.stdin,
      timeout: step.timeout ?? options?.timeout,
      captureLimit: options?.captureLimit,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: stepFailure(message, step, index, workdirPath, undefined, phase),
    };
  }

  if (execResult.timedOut) {
    return {
      ok: false,
      error: stepFailure(
        `${label} ${index} timed out: ${execResult.stderr}`,
        step,
        index,
        workdirPath,
        execResult,
        phase,
      ),
    };
  }

  const expectExitDeclared = step.expect_exit !== undefined;
  const expectedExitCode = expectExitDeclared
    ? (step.expect_exit as number)
    : 0;

  if (exitCodeIsFatal && execResult.exitCode !== expectedExitCode) {
    return {
      ok: false,
      error: stepFailure(
        `${label} ${index} exited with code ${execResult.exitCode}, expected ${expectedExitCode}`,
        step,
        index,
        workdirPath,
        execResult,
        phase,
      ),
    };
  }

  return { ok: true, execResult };
}

/**
 * Run a `surface: cli` flow's steps and (eventually) its assertions,
 * managing the flow's working directory lifecycle around them.
 */
export async function runCliFlow(
  flow: FlowSpec,
  options?: CliRunOptions,
): Promise<FlowResult> {
  const startTime = Date.now();
  const workdir = createFlowWorkdir(options?.cwd);

  const fail = async (error: FlowError): Promise<FlowResult> => {
    await workdir.dispose(false);
    return {
      success: false,
      flowName: flow.name,
      duration: Date.now() - startTime,
      error,
    };
  };

  // Setup phase: a flow-level setup block of CLI steps, run before the
  // flow's own steps, in the SAME working directory. Setup has no
  // assertion phase of its own, so every setup step — including the last
  // one in the array — always uses the non-final (exitCodeIsFatal: true)
  // rule; there is no "final step is assertion territory" concept here.
  // Failures are phase: "setup" with the setup step's own local index.
  if (flow.setup && flow.setup.length > 0) {
    const setupSteps = flow.setup as CliStep[];
    for (let setupIndex = 0; setupIndex < setupSteps.length; setupIndex++) {
      const outcome = await executeStep(
        setupSteps[setupIndex],
        setupIndex,
        workdir.path,
        options,
        true,
        "setup",
      );
      if (!outcome.ok) {
        return fail(outcome.error);
      }
    }
  }

  const steps = (flow.steps ?? []) as CliStep[];

  // Only the LAST run step's result is kept available past its own
  // iteration — intermediate steps' output is deliberately unaddressable
  // in v1. Setup steps never populate this: assertions evaluate against
  // the flow's own steps, not its setup.
  let lastExecResult:
    | { exitCode: number; stdout: string; stderr: string }
    | undefined;

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const isLastStep = index === steps.length - 1;
    // A non-final step, or a final step with an EXPLICIT expect_exit, is
    // fatal on mismatch. A final step with no expect_exit declared is
    // never fatal on exit code alone — its exit code is purely the
    // assertion phase's business.
    const exitCodeIsFatal = !isLastStep || step.expect_exit !== undefined;

    const outcome = await executeStep(
      step,
      index,
      workdir.path,
      options,
      exitCodeIsFatal,
    );
    if (!outcome.ok) {
      return fail(outcome.error);
    }
    lastExecResult = outcome.execResult;
  }

  // Assertion phase: evaluate flow.expect in order against the last step's
  // captured result, stopping at the first failure. Every fixture in
  // WI-808/811's own test suites uses expect: [], which has nothing to
  // evaluate (the loop below is simply a no-op for them).
  if (lastExecResult) {
    for (const assertion of (flow.expect ?? []) as CliAssertion[]) {
      const failure = await evaluateCliAssertion(
        assertion,
        lastExecResult,
        workdir.path,
        options?.timeout ?? 0,
      );
      if (failure) {
        return fail({
          message: failure.message,
          exitCode: failure.exitCode,
          stdout: failure.stdout,
          stderr: failure.stderr,
          workdir: failure.workdir,
        });
      }
    }
  }

  await workdir.dispose(true);
  return {
    success: true,
    flowName: flow.name,
    duration: Date.now() - startTime,
  };
}
