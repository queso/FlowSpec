#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, mergeConfig } from "./config.js";
import { formatInitResult, initProject } from "./init.js";
import { parseFlowFile } from "./parser.js";
import { formatResult, formatSummary } from "./reporter.js";
import { DEFAULT_TIMEOUT, runFlow } from "./runner.js";
import type { FlowResult, FlowSpec } from "./types.js";

interface CliOptions {
  path?: string;
  baseUrl?: string;
  timeout?: number;
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
  --help            Show help

Init Command:
  Creates FlowSpec configuration in the current directory:
    - flowspec.config.yaml (project settings)
    - specs/example.flow.yaml (sample flow)
    - .claude/settings.local.json (protects specs from AI edits)

Exit codes:
  0  All flows passed
  1  One or more flows failed
  2  Parse error (invalid YAML/schema)
`);
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
  timeout?: number,
): Promise<FlowResult[]> {
  const results: FlowResult[] = [];

  for (const { flow } of parsedFlows) {
    const result = await runFlow(flow, { baseUrl, timeout });
    console.log(formatResult(result));
    results.push(result);
  }

  return results;
}

function handleInitCommand(): void {
  const result = initProject(process.cwd());
  console.log(formatInitResult(result));
  process.exit(result.success ? 0 : 1);
}

async function handleRunCommand(args: string[]): Promise<void> {
  const options = parseArgs(args);

  if (options.showHelp) {
    showHelp();
    process.exit(0);
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

  // Load configuration and merge with CLI options
  const config = loadConfig();
  const mergedConfig = mergeConfig(config, {
    baseUrl: options.baseUrl,
    timeout: options.timeout,
  });

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
    handleInitCommand();
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
