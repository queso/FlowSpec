import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Result of creating a single file during init
 */
export interface InitFileResult {
  path: string;
  created: boolean;
  skipped: boolean;
  error?: string;
}

/**
 * Result of the init command
 */
export interface InitResult {
  files: InitFileResult[];
  success: boolean;
}

/**
 * Default content for flowspec.config.yaml
 */
export const DEFAULT_CONFIG_CONTENT = `baseUrl: http://localhost:3000
timeout: 10000
specsDir: specs/
`;

/**
 * Default content for example flow file
 */
export const DEFAULT_EXAMPLE_FLOW_CONTENT = `name: example-flow
description: Example flow - customize this for your app
steps:
  - visit: /
expect:
  - visible: Welcome
`;

/**
 * Default content for Claude settings to protect specs
 */
export const DEFAULT_CLAUDE_SETTINGS_CONTENT = `{
  "hooks": {
    "PreToolUse": [{
      "matcher": { "tool": ["Edit", "Write"], "path": "specs/**/*.flow.yaml" },
      "command": "echo '❌ Flow specs are immutable. Fix the implementation, not the spec.' && exit 1"
    }]
  }
}
`;

/**
 * Safely create a directory if it doesn't exist
 */
function ensureDirectory(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Create a file if it doesn't exist
 * @returns Result indicating whether file was created or skipped
 */
function createFileIfNotExists(
  filePath: string,
  content: string,
): InitFileResult {
  const result: InitFileResult = {
    path: filePath,
    created: false,
    skipped: false,
  };

  try {
    if (existsSync(filePath)) {
      result.skipped = true;
      return result;
    }

    // Ensure parent directory exists
    const parentDir = dirname(filePath);
    ensureDirectory(parentDir);

    writeFileSync(filePath, content, "utf-8");
    result.created = true;
  } catch (error) {
    result.error =
      error instanceof Error ? error.message : "Unknown error occurred";
  }

  return result;
}

/**
 * Update package.json with test:e2e script if it exists
 * @returns Result indicating whether package.json was updated
 */
function updatePackageJson(projectDir: string): InitFileResult {
  const packageJsonPath = join(projectDir, "package.json");
  const result: InitFileResult = {
    path: packageJsonPath,
    created: false,
    skipped: false,
  };

  try {
    if (!existsSync(packageJsonPath)) {
      result.skipped = true;
      return result;
    }

    const content = readFileSync(packageJsonPath, "utf-8");
    const pkg = JSON.parse(content) as Record<string, unknown>;

    // Ensure scripts object exists
    if (!pkg.scripts || typeof pkg.scripts !== "object") {
      pkg.scripts = {};
    }

    const scripts = pkg.scripts as Record<string, string>;

    // Check if test:e2e already exists
    if (scripts["test:e2e"]) {
      result.skipped = true;
      return result;
    }

    // Add the test:e2e script
    scripts["test:e2e"] = "flowspec run";

    // Write back with proper formatting
    writeFileSync(
      packageJsonPath,
      `${JSON.stringify(pkg, null, 2)}\n`,
      "utf-8",
    );
    result.created = true;
  } catch (error) {
    result.error =
      error instanceof Error ? error.message : "Unknown error occurred";
  }

  return result;
}

/**
 * Initialize FlowSpec in a project directory
 * Creates configuration files and example flow
 *
 * @param projectDir - Directory to initialize (defaults to cwd)
 * @returns Result with details about each file created
 */
export function initProject(projectDir: string = process.cwd()): InitResult {
  const files: InitFileResult[] = [];

  // 1. Create flowspec.config.yaml
  const configResult = createFileIfNotExists(
    join(projectDir, "flowspec.config.yaml"),
    DEFAULT_CONFIG_CONTENT,
  );
  files.push(configResult);

  // 2. Create specs/example.flow.yaml
  const exampleFlowResult = createFileIfNotExists(
    join(projectDir, "specs", "example.flow.yaml"),
    DEFAULT_EXAMPLE_FLOW_CONTENT,
  );
  files.push(exampleFlowResult);

  // 3. Create .claude/settings.local.json
  const claudeSettingsResult = createFileIfNotExists(
    join(projectDir, ".claude", "settings.local.json"),
    DEFAULT_CLAUDE_SETTINGS_CONTENT,
  );
  files.push(claudeSettingsResult);

  // 4. Update package.json if it exists
  const packageJsonResult = updatePackageJson(projectDir);
  files.push(packageJsonResult);

  // Determine overall success
  const success = files.every((f) => !f.error);

  return { files, success };
}

/**
 * Format the init result for console output
 */
export function formatInitResult(result: InitResult): string {
  const lines: string[] = [];

  for (const file of result.files) {
    const relativePath = file.path.includes("/")
      ? file.path.split("/").slice(-2).join("/")
      : file.path;

    // Get just the filename or last path component
    const displayPath = file.path.endsWith("package.json")
      ? "Added test:e2e script to package.json"
      : relativePath;

    if (file.error) {
      lines.push(`✗ Failed to create ${displayPath}: ${file.error}`);
    } else if (file.skipped) {
      if (file.path.endsWith("package.json")) {
        // Don't show anything for skipped package.json (either doesn't exist or already has script)
        continue;
      }
      lines.push(`· Skipped ${displayPath} (already exists)`);
    } else if (file.created) {
      if (file.path.endsWith("package.json")) {
        lines.push(`✓ ${displayPath}`);
      } else {
        lines.push(`✓ Created ${displayPath}`);
      }
    }
  }

  if (result.success) {
    lines.push("");
    lines.push("FlowSpec initialized! Next steps:");
    lines.push("  1. Edit specs/example.flow.yaml for your app");
    lines.push("  2. Start your app on http://localhost:3000");
    lines.push("  3. Run: flowspec run");
  }

  return lines.join("\n");
}
