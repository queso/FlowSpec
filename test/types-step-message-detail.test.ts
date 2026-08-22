/**
 * Post-mission sweep fix S8: a step (or assertion) whose verb IS recognized
 * but whose value is malformed must report the SPECIFIC problem, at the
 * field that has it.
 *
 * `validateStepForSurface` used to re-parse the step against a union schema
 * and join Zod's top-level issue messages verbatim. For a union, that
 * top-level message is the generic "Invalid input" — the useful detail
 * ("Expected string, received number") lives inside `unionErrors[branch]`.
 * The field path was discarded too, so two DIFFERENT malformed sub-fields on
 * the same step produced byte-identical errors.
 *
 * The config-level twin of this function (`describeMalformedWebStep` in
 * src/config.ts) was fixed for the web surface earlier in the mission; this
 * pins the same contract for both surfaces at the FlowSpec level.
 *
 * Assertions here are written against the formatted `path: message` form
 * that src/parser.ts (and src/config.ts's loadConfigFile) actually show a
 * user, since the fix re-issues Zod's own message at its composed field
 * path rather than smuggling the field name into the message text.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfigFile } from "../src/config";
import { FlowSpecSchema } from "../src/types";

const ownedDirs: string[] = [];

afterEach(() => {
  for (const dir of ownedDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Mirrors src/parser.ts's formatZodError: what the user actually reads. */
function formatIssues(
  result: ReturnType<typeof FlowSpecSchema.safeParse>,
): string {
  if (result.success) {
    return "";
  }
  return result.error.issues
    .map(
      (issue) =>
        `${issue.path.length > 0 ? issue.path.join(".") : "root"}: ${issue.message}`,
    )
    .join("; ");
}

function webFlow(overrides: Record<string, unknown> = {}) {
  return {
    name: "web-flow",
    description: "A web flow",
    steps: [{ visit: "/home" }],
    expect: [{ visible: "Hello" }],
    ...overrides,
  };
}

function cliFlow(overrides: Record<string, unknown> = {}) {
  return {
    name: "cli-flow",
    description: "A cli flow",
    surface: "cli",
    steps: [{ run: "flowspec init" }],
    expect: [{ exit_code: 0 }],
    ...overrides,
  };
}

describe("web step: a recognized verb with a malformed value", () => {
  it("reports the specific Zod issue for { click: 123 }, not a generic 'Invalid input'", () => {
    const result = FlowSpecSchema.safeParse(
      webFlow({ steps: [{ click: 123 }] }),
    );

    expect(result.success).toBe(false);
    const formatted = formatIssues(result);
    expect(formatted).toContain("Expected string");
    expect(formatted).not.toContain("Invalid input");
    // and it names the field that is actually wrong
    expect(formatted).toContain("steps.0.click");
  });

  it("gives two different malformed sub-fields two different errors, each naming its own field", () => {
    const wrongType = formatIssues(
      FlowSpecSchema.safeParse(webFlow({ steps: [{ fill: { Email: 42 } }] })),
    );
    const wrongVerbValue = formatIssues(
      FlowSpecSchema.safeParse(webFlow({ steps: [{ visit: 42 }] })),
    );

    expect(wrongType).not.toBe(wrongVerbValue);
    expect(wrongType).toContain("steps.0.fill.Email");
    expect(wrongVerbValue).toContain("steps.0.visit");
    expect(wrongType).not.toContain("Invalid input");
    expect(wrongVerbValue).not.toContain("Invalid input");
  });

  it("keeps naming the unrecognized key when a web step carries an extra field", () => {
    const formatted = formatIssues(
      FlowSpecSchema.safeParse(
        webFlow({ steps: [{ visit: "/home", bogus_extra: 1 }] }),
      ),
    );

    expect(formatted).toContain("bogus_extra");
  });
});

describe("cli step: a recognized verb with a malformed modifier", () => {
  it("gives two different malformed modifiers two different errors, each naming its own field", () => {
    const badStdin = formatIssues(
      FlowSpecSchema.safeParse(
        cliFlow({ steps: [{ run: "echo hi", stdin: 123 }] }),
      ),
    );
    const badTimeout = formatIssues(
      FlowSpecSchema.safeParse(
        cliFlow({ steps: [{ run: "echo hi", timeout: 0 }] }),
      ),
    );

    expect(badStdin).not.toBe(badTimeout);
    expect(badStdin).toContain("steps.0.stdin");
    expect(badStdin).toContain("Expected string");
    expect(badTimeout).toContain("steps.0.timeout");
    expect(badTimeout).toContain("greater than 0");
    expect(badStdin).not.toContain("Invalid input");
    expect(badTimeout).not.toContain("Invalid input");
  });

  it("reports the specific problem for a run value of the wrong type, naming run", () => {
    const formatted = formatIssues(
      FlowSpecSchema.safeParse(cliFlow({ steps: [{ run: 42 }] })),
    );

    expect(formatted).toContain("steps.0.run");
    expect(formatted).toContain("received number");
    expect(formatted).not.toContain("Invalid input");
  });

  it("distinguishes a missing run from a wrongly-typed run", () => {
    const missing = formatIssues(
      FlowSpecSchema.safeParse(cliFlow({ steps: [{ stdin: "y\n" }] })),
    );
    const wrongType = formatIssues(
      FlowSpecSchema.safeParse(cliFlow({ steps: [{ run: 42 }] })),
    );

    expect(missing).not.toBe(wrongType);
  });
});

describe("cli assertion: a recognized verb with a malformed payload", () => {
  it("names the offending sub-field of a malformed file_contains", () => {
    const formatted = formatIssues(
      FlowSpecSchema.safeParse(
        cliFlow({ expect: [{ file_contains: { path: "out.txt", text: 42 } }] }),
      ),
    );

    expect(formatted).toContain("expect.0.file_contains.text");
    expect(formatted).not.toContain("Invalid input");
  });
});

describe("config-level setup keeps its own specific messages", () => {
  it("reports the specific issue, at its field, for a malformed config setup step", () => {
    const dir = mkdtempSync(join(tmpdir(), "flowspec-step-detail-"));
    ownedDirs.push(dir);
    const configPath = join(dir, "flowspec.config.yaml");
    writeFileSync(configPath, "setup:\n  - visit: 123\n");

    try {
      loadConfigFile(configPath);
      throw new Error("expected loadConfigFile to throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("Expected string");
      expect(message).toContain("setup.0.visit");
      expect(message).not.toContain("Unsupported step");
    }
  });
});
