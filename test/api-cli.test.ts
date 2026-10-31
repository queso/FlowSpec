import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  BUY_SCOPE,
  createSiloFixture,
  ISSUED_TOKEN,
  QUOTE_SCOPE,
} from "./api-server";

/**
 * End-to-end tests for `surface: api` through the real CLI entry point
 * (src/index.ts), against the silo fixture servers running in this process.
 * Everything checked here is what a user sees: exit code, stdout, stderr,
 * and the requests the server actually received.
 */

const CLI_PATH = join(__dirname, "..", "src", "index.ts");

const BUY_KEY = "key_quote_and_buy_e2e_0002";
const SECRET_KEY = "sk_live_e2e_secret_value_42";

const fixture = createSiloFixture({
  keys: { [BUY_KEY]: [QUOTE_SCOPE, BUY_SCOPE] },
});

let workdir: string;

beforeAll(async () => {
  await fixture.start();
});

afterAll(async () => {
  await fixture.stop();
});

beforeEach(() => {
  fixture.resetObservations();
  workdir = mkdtempSync(join(tmpdir(), "flowspec-api-cli-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function writeFlow(name: string, body: string): string {
  const path = join(workdir, name);
  writeFileSync(path, body);
  return path;
}

function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const child = spawn(
      "bun",
      ["run", CLI_PATH, "run", ...args, "--base-url", fixture.porterUrl],
      { cwd: workdir, env: { ...process.env, ...env }, timeout: 25000 },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("close", (code) =>
      resolve({ stdout, stderr, exitCode: code ?? 1 }),
    );
  });
}

function markFlow(name: string): string {
  return `
name: ${name}
description: records its start and end on the server
surface: api
steps:
  - request: {get: "/__test/mark?flow=${name}&event=start"}
  - wait: 150
  - request: {get: "/__test/mark?flow=${name}&event=end"}
expect:
  - status: 200
`;
}

describe("execution order", () => {
  it("runs a directory's flows one at a time in sorted path order", async () => {
    writeFlow("b-second.flow.yaml", markFlow("b"));
    writeFlow("c-third.flow.yaml", markFlow("c"));
    writeFlow("a-first.flow.yaml", markFlow("a"));

    const result = await runCli([workdir]);

    expect(result.exitCode).toBe(0);
    expect(fixture.marks).toEqual([
      "a:start",
      "a:end",
      "b:start",
      "b:end",
      "c:start",
      "c:end",
    ]);
  });

  it("runs files named on the command line in the order given", async () => {
    const a = writeFlow("a.flow.yaml", markFlow("a"));
    const b = writeFlow("b.flow.yaml", markFlow("b"));
    const c = writeFlow("c.flow.yaml", markFlow("c"));

    const result = await runCli([c, a, b]);

    expect(result.exitCode).toBe(0);
    expect(fixture.marks).toEqual([
      "c:start",
      "c:end",
      "a:start",
      "a:end",
      "b:start",
      "b:end",
    ]);
    expect(result.stdout).toContain("3 flows: 3 passed, 0 failed");
  });
});

describe("unset env references", () => {
  it("fail the run at load time, before any flow sends a request", async () => {
    writeFlow(
      "a-buys.flow.yaml",
      `
name: buys-first
description: would send a POST if it ran
surface: api
steps:
  - request: {post: /__test/tokens}
    expect:
      - status: 201
`,
    );
    const second = writeFlow(
      "b-needs-key.flow.yaml",
      `
name: needs-key
description: references an env variable that is not set
surface: api
steps:
  - request:
      post: /__test/tokens
      headers: {Authorization: "Bearer {env.FLOWSPEC_E2E_NEVER_SET}"}
    expect:
      - status: 201
`,
    );

    const result = await runCli([workdir]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(second);
    expect(result.stderr).toContain(
      'Environment variable "FLOWSPEC_E2E_NEVER_SET" is not set (referenced as {env.FLOWSPEC_E2E_NEVER_SET} at steps.0.request.headers.Authorization)',
    );
    expect(fixture.requestCount("POST", "/__test/tokens")).toBe(0);
    expect(fixture.requestLog).toEqual([]);
  });
});

describe("redaction", () => {
  it("keeps env values out of failure messages, expected values and recorded request headers", async () => {
    const flowPath = writeFlow(
      "leaks.flow.yaml",
      `
name: env-secret-in-failure
description: a failing step whose request header and expected value both carry the secret
surface: api
steps:
  - request:
      post: /__test/echo/secret
      headers: {Authorization: "Bearer {env.E2E_SECRET_KEY}"}
      json: {key: "{env.E2E_SECRET_KEY}"}
    expect:
      - json: {path: "$.path", equals: "{env.E2E_SECRET_KEY}"}
`,
    );

    const result = await runCli([flowPath], { E2E_SECRET_KEY: SECRET_KEY });
    const output = result.stdout + result.stderr;

    expect(result.exitCode).toBe(1);
    expect(output).not.toContain(SECRET_KEY);
    expect(output).toContain(
      'json $.path expected "[REDACTED:E2E_SECRET_KEY]" but got "/__test/echo/secret"',
    );
    expect(output).toContain("authorization: Bearer [REDACTED:E2E_SECRET_KEY]");
    expect(output).toContain(
      'Request body: {"key":"[REDACTED:E2E_SECRET_KEY]"}',
    );
  });

  it("keeps a secret capture out of response bodies and failure messages", async () => {
    const flowPath = writeFlow(
      "token.flow.yaml",
      `
name: secret-capture
description: captures a token as secret, then fails on a response that echoes it
surface: api
steps:
  - request: {post: /__test/tokens}
    capture: {token: {path: "$.token", secret: true}}
    expect:
      - status: 201
  - request:
      get: /__test/whoami
      headers: {Authorization: "Bearer {token}"}
    timeout: 0
    expect:
      - json: {path: "$.authorization", equals: "Bearer nope"}
`,
    );

    const result = await runCli([flowPath]);
    const output = result.stdout + result.stderr;

    expect(result.exitCode).toBe(1);
    expect(output).not.toContain(ISSUED_TOKEN);
    expect(output).toContain(
      'json $.authorization expected "Bearer nope" but got "Bearer [REDACTED:token]"',
    );
    expect(output).toContain("authorization: Bearer [REDACTED:token]");
    expect(output).toContain(
      'Response body: {"authorization":"Bearer [REDACTED:token]"}',
    );
  });

  it("does not redact a value under 8 characters and warns once, naming the variable", async () => {
    const flowPath = writeFlow(
      "short.flow.yaml",
      `
name: short-secret
description: a short env value appears in a failure message
surface: api
steps:
  - request: {get: "/__test/echo/{env.E2E_SHORT}"}
    timeout: 0
    expect:
      - json: {path: "$.path", equals: "/__test/echo/x-{env.E2E_SHORT}"}
`,
    );

    const result = await runCli([flowPath], { E2E_SHORT: "abc12" });

    expect(result.exitCode).toBe(1);
    const warning =
      "Warning: {env.E2E_SHORT} is shorter than 8 characters, so its value is not redacted from output";
    expect(result.stderr).toContain(warning);
    expect(result.stderr.split(warning)).toHaveLength(2);
    expect(result.stdout).toContain('"/__test/echo/x-abc12"');
  });
});

describe("exit codes", () => {
  it("exits 0 when every api flow passes and 1 when one fails", async () => {
    const passing = writeFlow(
      "pass.flow.yaml",
      `
name: passes
description: passes
surface: api
steps:
  - request: {get: /__test/echo/ok}
    expect:
      - status: 200
`,
    );
    const failing = writeFlow(
      "fail.flow.yaml",
      `
name: fails
description: fails
surface: api
steps:
  - request: {get: /__test/echo/ok}
    timeout: 0
    expect:
      - status: 201
`,
    );

    expect((await runCli([passing])).exitCode).toBe(0);
    const result = await runCli([passing, failing]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("2 flows: 1 passed, 1 failed");
  });

  it("exits 2 for a web verb in an api flow, naming the verb and surface", async () => {
    const flowPath = writeFlow(
      "mixed.flow.yaml",
      `
name: mixed
description: mixes surfaces
surface: api
steps:
  - visit: /home
expect:
  - status: 200
`,
    );
    const result = await runCli([flowPath]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      'Step verb "visit" is not valid for surface "api"',
    );
  });
});
