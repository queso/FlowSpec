import { describe, expect, it } from "vitest";
import { Redactor } from "../src/redact";

function redactorWithWarnings() {
  const warnings: string[] = [];
  const redactor = new Redactor((message) => warnings.push(message));
  return { redactor, warnings };
}

describe("Redactor", () => {
  it("replaces every occurrence of an env secret with [REDACTED:NAME]", () => {
    const { redactor } = redactorWithWarnings();
    redactor.addEnvSecret("PORTER_BUY_KEY", "sk_live_buy_123456");
    expect(
      redactor.redact(
        "Authorization: Bearer sk_live_buy_123456 and again sk_live_buy_123456",
      ),
    ).toBe(
      "Authorization: Bearer [REDACTED:PORTER_BUY_KEY] and again [REDACTED:PORTER_BUY_KEY]",
    );
  });

  it("labels a secret capture by its variable name", () => {
    const { redactor } = redactorWithWarnings();
    redactor.addCaptureSecret("token", "tok_abcdefghijkl");
    expect(redactor.redact('{"token":"tok_abcdefghijkl"}')).toBe(
      '{"token":"[REDACTED:token]"}',
    );
  });

  it("redacts the JSON-escaped and URL-encoded forms of a secret", () => {
    const { redactor } = redactorWithWarnings();
    redactor.addEnvSecret("ODD", 'a"b c/d&e=f');
    expect(redactor.redact(JSON.stringify({ v: 'a"b c/d&e=f' }))).toBe(
      '{"v":"[REDACTED:ODD]"}',
    );
    expect(redactor.redact(`/x?k=${encodeURIComponent('a"b c/d&e=f')}`)).toBe(
      "/x?k=[REDACTED:ODD]",
    );
    expect(
      redactor.redact(`/x?${new URLSearchParams({ k: 'a"b c/d&e=f' })}`),
    ).toBe("/x?k=[REDACTED:ODD]");
  });

  it("replaces a longer secret before a shorter one it contains", () => {
    const { redactor } = redactorWithWarnings();
    redactor.addEnvSecret("SHORTER", "abcdefgh");
    redactor.addEnvSecret("LONGER", "abcdefgh-ijkl");
    expect(redactor.redact("abcdefgh-ijkl abcdefgh")).toBe(
      "[REDACTED:LONGER] [REDACTED:SHORTER]",
    );
  });

  it("does not redact a value under 8 characters and warns once, naming the variable", () => {
    const { redactor, warnings } = redactorWithWarnings();
    redactor.addEnvSecret("PIN", "1234");
    redactor.addEnvSecret("PIN", "1234");
    redactor.addCaptureSecret("code", 42);
    expect(redactor.redact("pin 1234 code 42")).toBe("pin 1234 code 42");
    expect(warnings).toEqual([
      "Warning: {env.PIN} is shorter than 8 characters, so its value is not redacted from output",
      "Warning: {code} is shorter than 8 characters, so its value is not redacted from output",
    ]);
  });

  it("redacts every string inside a nested value without mutating it", () => {
    const { redactor } = redactorWithWarnings();
    redactor.addEnvSecret("KEY", "secret-value-1");
    const original = {
      message: "expected secret-value-1",
      request: { headers: { authorization: "Bearer secret-value-1" } },
      list: ["secret-value-1", 3],
    };
    const redacted = redactor.redactDeep(original);
    expect(redacted).toEqual({
      message: "expected [REDACTED:KEY]",
      request: { headers: { authorization: "Bearer [REDACTED:KEY]" } },
      list: ["[REDACTED:KEY]", 3],
    });
    expect(original.message).toBe("expected secret-value-1");
  });

  it("redacts a non-string secret by its string form", () => {
    const { redactor } = redactorWithWarnings();
    redactor.addCaptureSecret("account", 1234567890123);
    expect(redactor.redact("account 1234567890123")).toBe(
      "account [REDACTED:account]",
    );
  });
});
