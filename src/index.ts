#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_FILE_NAME, loadConfig, mergeConfig } from "./config.js";
import { formatInitResult, initProject } from "./init.js";
import { parseFlowFile } from "./parser.js";
import { formatResult, formatSummary } from "./reporter.js";
import { DEFAULT_TIMEOUT, runFlow } from "./runner.js";
import type { FlowResult, FlowSpec, FlowStep } from "./types.js";

interface CliOptions {
  path?: string;
  baseUrl?: string;
  timeout?: number;
  headers?: Record<string, string>;
  /** First malformed --header argument, if any. */
  headerError?: string;
  showHelp: boolean;
}

function showHelp(): void {
  console.log(`
Usage: flowspec <command> [options]

Commands:
  init              Initialize FlowSpec in the current directory
  run <path>        Run FlowSpec flow files

Run Command Options:
  --base-url <url>  Base URL for relative paths (default from config or http://localhost:3000)
  --timeout <ms>    Assertion retry timeout in milliseconds (default: ${DEFAULT_TIMEOUT})
  --header "Name: value"
                    Extra HTTP header to send. Repeatable; overrides the
                    config headers block entirely
  --help            Show help

Init Command Options:
  --dir <path>      Target directory (default: current directory)

  Creates FlowSpec configuration in the target directory:
    - flowspec.config.yaml (project settings)
    - specs/example.flow.yaml (sample flow)
    - .claude/settings.local.json (protects specs from AI edits)

Exit codes:
  0  All flows passed
  1  One or more flows failed
  2  Parse error, a malformed --header, or a config file that fails to load
     or validate (invalid YAML, schema, or an unset \${VAR})
`);
}

/**
 * Parse one `--header "Name: value"` argument.
 *
 * Splits at the FIRST colon so a value may contain colons of its own
 * ("authorization: Bearer a:b"), and trims both halves so the conventional
 * space after the colon is not part of the value. Returns the parsed pair, or
 * a one-line error message describing what is wrong with the argument.
 *
 * No ${VAR} interpolation happens here, unlike config-file values: the shell
 * has already had its chance to expand the argument, so a reference that
 * survived quoting is a literal the user meant to send.
 */
function parseHeaderArg(arg: string): { name: string; value: string } | string {
  const colonIndex = arg.indexOf(":");

  if (colonIndex === -1) {
    return `Error: invalid --header "${arg}" - expected "Name: value"`;
  }

  const name = arg.slice(0, colonIndex).trim();
  if (name === "") {
    return `Error: invalid --header "${arg}" - the header name is empty`;
  }

  return { name, value: arg.slice(colonIndex + 1).trim() };
}

/**
 * Keep the FIRST header error. Reporting the earliest malformed flag points
 * the user at the one they can fix without re-running to discover the next.
 */
function recordHeaderError(options: CliOptions, message: string): void {
  options.headerError ??= message;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    showHelp: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      options.showHelp = true;
    } else if (arg === "--base-url" && i + 1 < args.length) {
      options.baseUrl = args[++i];
    } else if (arg === "--timeout" && i + 1 < args.length) {
      const timeoutValue = Number.parseInt(args[++i], 10);
      if (!Number.isNaN(timeoutValue)) {
        options.timeout = timeoutValue;
      }
    } else if (arg === "--header") {
      const headerArg = args[i + 1];
      if (headerArg === undefined) {
        recordHeaderError(
          options,
          'Error: --header requires a "Name: value" argument',
        );
        continue;
      }
      i++;

      const parsed = parseHeaderArg(headerArg);
      if (typeof parsed === "string") {
        recordHeaderError(options, parsed);
      } else {
        // Later duplicates win, matching how every other repeatable
        // "last one wins" CLI flag behaves.
        options.headers = { ...options.headers, [parsed.name]: parsed.value };
      }
    } else if (!arg.startsWith("-") && !options.path) {
      options.path = arg;
    }
  }

  return options;
}

function discoverFlowFiles(path: string): string[] {
  const absolutePath = resolve(path);

  if (!existsSync(absolutePath)) {
    return [];
  }

  const stats = statSync(absolutePath);

  if (stats.isFile()) {
    return [absolutePath];
  }

  if (stats.isDirectory()) {
    const files = readdirSync(absolutePath);
    return files
      .filter((file) => file.endsWith(".flow.yaml"))
      .map((file) => join(absolutePath, file))
      .sort();
  }

  return [];
}

interface ParsedFlow {
  filePath: string;
  flow: FlowSpec;
}

interface ParseError {
  filePath: string;
  error: string;
}

function parseFlowFiles(filePaths: string[]): {
  flows: ParsedFlow[];
  errors: ParseError[];
} {
  const flows: ParsedFlow[] = [];
  const errors: ParseError[] = [];

  for (const filePath of filePaths) {
    try {
      const flow = parseFlowFile(filePath);
      flows.push({ filePath, flow });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ filePath, error: message });
    }
  }

  return { flows, errors };
}

async function runFlows(
  parsedFlows: ParsedFlow[],
  baseUrl: string,
  timeout: number | undefined,
  configSetup: FlowStep[] | undefined,
  configHeaders: Record<string, string> | undefined,
  configHeadersScope: "origin" | "all" | undefined,
  configCwd: string | undefined,
  configCaptureLimit: number | undefined,
): Promise<FlowResult[]> {
  const results: FlowResult[] = [];

  for (let i = 0; i < parsedFlows.length; i++) {
    const { flow } = parsedFlows[i];
    const result = await runFlow(flow, {
      baseUrl,
      timeout,
      setup: configSetup,
      headers: configHeaders,
      headersScope: configHeadersScope,
      cwd: configCwd,
      captureLimit: configCaptureLimit,
    });
    console.log(formatResult(result));
    results.push(result);

    // A setup failure "came from config" exactly when this flow declared no
    // setup of its own (an explicit empty list means the flow opted out and
    // cannot have failed in setup at all). A shared setup failing means
    // every remaining flow would fail the same way, so stop the run and
    // report the rest as skipped rather than repeating the same error.
    const failedSetupFromConfig =
      !result.success &&
      result.error?.phase === "setup" &&
      flow.setup === undefined;

    // Headers are config-only — a flow cannot declare its own — so a
    // headers-phase failure is always shared and every remaining flow would
    // fail applying the same headers.
    const failedHeadersFromConfig =
      !result.success && result.error?.phase === "headers";

    if (failedSetupFromConfig || failedHeadersFromConfig) {
      // Say why the run stopped, and name the part of the config that
      // actually failed — pointing at `setup:` for a headers failure would
      // send the user debugging a block that is fine (or absent).
      if (i + 1 < parsedFlows.length) {
        console.log(
          failedHeadersFromConfig
            ? `Aborting run: applying the shared headers from ${CONFIG_FILE_NAME} failed. Remaining flows skipped.`
            : `Aborting run: the shared setup in ${CONFIG_FILE_NAME} failed. Remaining flows skipped.`,
        );
      }

      for (let j = i + 1; j < parsedFlows.length; j++) {
        const skippedResult: FlowResult = {
          success: false,
          flowName: parsedFlows[j].flow.name,
          duration: 0,
          skipped: true,
        };
        console.log(formatResult(skippedResult));
        results.push(skippedResult);
      }
      break;
    }
  }

  return results;
}

function handleInitCommand(args: string[] = []): void {
  // --help wins over everything else, including a malformed --dir
  if (args.includes("--help") || args.includes("-h")) {
    showHelp();
    process.exit(0);
  }

  // Parse --dir flag
  let targetDir = process.cwd();
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--dir") continue;

    // A missing value must not silently fall back to cwd — scaffolding the
    // directory the user happens to be standing in is a destructive surprise.
    const value = args[i + 1];
    if (value === undefined || value.startsWith("-")) {
      console.error("Error: --dir requires a directory path");
      console.error("Usage: flowspec init --dir <path>");
      process.exit(1);
    }

    targetDir = resolve(process.cwd(), value);
    i++;
  }

  // Create the directory if it doesn't exist
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  const result = initProject(targetDir);
  console.log(formatInitResult(result));
  process.exit(result.success ? 0 : 1);
}

async function handleRunCommand(args: string[]): Promise<void> {
  const options = parseArgs(args);

  if (options.showHelp) {
    showHelp();
    process.exit(0);
  }

  // A malformed --header is a misconfiguration, not a flow failure: exit 2
  // before any flow parses and before any browser session opens, exactly as
  // an invalid config file does.
  if (options.headerError) {
    console.error(options.headerError);
    process.exit(2);
  }

  if (!options.path) {
    console.error("Error: No path specified");
    showHelp();
    process.exit(1);
  }

  const absolutePath = resolve(options.path);

  if (!existsSync(absolutePath)) {
    console.error(`Error: Path not found: ${options.path}`);
    process.exit(1);
  }

  // Load configuration and merge with CLI options. A misconfigured project
  // (bad YAML, failed schema validation, an unresolved ${VAR}) must fail
  // fast with exit code 2 — before any flow is parsed and before any
  // browser session opens — matching the existing parse-error contract.
  let mergedConfig: ReturnType<typeof mergeConfig>;
  try {
    const config = loadConfig();
    mergedConfig = mergeConfig(config, {
      baseUrl: options.baseUrl,
      timeout: options.timeout,
      headers: options.headers,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }

  const flowFiles = discoverFlowFiles(options.path);

  if (flowFiles.length === 0) {
    console.log("No flow files found");
    process.exit(0);
  }

  // Parse all flow files first
  const { flows, errors } = parseFlowFiles(flowFiles);

  // If there are parse errors, report them and exit with code 2
  if (errors.length > 0) {
    for (const { filePath, error } of errors) {
      console.error(`Error parsing ${filePath}:`);
      console.error(`  ${error}`);
    }
    process.exit(2);
  }

  // Run all flows
  const results = await runFlows(
    flows,
    mergedConfig.baseUrl,
    mergedConfig.timeout,
    mergedConfig.setup,
    mergedConfig.headers,
    mergedConfig.headersScope,
    mergedConfig.cwd,
    mergedConfig.captureLimit,
  );

  // Print summary
  console.log();
  console.log(formatSummary(results));

  // Exit with appropriate code
  const allPassed = results.every((r) => r.success);
  process.exit(allPassed ? 0 : 1);
}

async function main(): Promise<void> {
  // Skip first two args: "bun" and script path
  const args = process.argv.slice(2);

  // Handle case when no arguments
  if (args.length === 0) {
    showHelp();
    process.exit(0);
  }

  // Extract the command
  const command = args[0];

  if (command === "init") {
    handleInitCommand(args.slice(1));
  } else if (command === "run") {
    await handleRunCommand(args.slice(1));
  } else if (command === "--help" || command === "-h") {
    showHelp();
    process.exit(0);
  } else {
    console.error(`Unknown command: ${command}`);
    showHelp();
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Unexpected error:", error.message);
  process.exit(1);
});
