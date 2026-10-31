/**
 * Secret redaction for run output.
 *
 * Every value a flow reads through `{env.NAME}`, and every capture marked
 * `secret: true`, is a secret for the rest of the run. Before output is
 * written, each occurrence of a secret is replaced with `[REDACTED:NAME]`.
 *
 * Values shorter than MIN_REDACTABLE_LENGTH are not redacted: replacing a
 * short substring everywhere would mangle unrelated output. A warning naming
 * the variable is emitted instead, once per variable.
 */

export const MIN_REDACTABLE_LENGTH = 8;

interface Secret {
  label: string;
  /** The forms the value can take in output: raw, JSON-escaped, URL-encoded. */
  forms: string[];
}

function secretString(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function encodedForms(value: string): string[] {
  const forms = new Set([
    value,
    JSON.stringify(value).slice(1, -1),
    encodeURIComponent(value),
    new URLSearchParams({ v: value }).toString().slice(2),
  ]);
  return [...forms];
}

export class Redactor {
  private readonly secrets: Secret[] = [];
  private readonly seenLabels = new Set<string>();
  private readonly warnedReferences = new Set<string>();

  constructor(
    private readonly warn: (message: string) => void = (message) =>
      console.error(message),
  ) {}

  /** Register the value of `{env.NAME}`. */
  addEnvSecret(name: string, value: unknown): void {
    this.add(name, `{env.${name}}`, value);
  }

  /** Register the value of a capture marked `secret: true`. */
  addCaptureSecret(name: string, value: unknown): void {
    this.add(name, `{${name}}`, value);
  }

  private add(label: string, reference: string, value: unknown): void {
    const text = secretString(value);

    if (text.length < MIN_REDACTABLE_LENGTH) {
      if (!this.warnedReferences.has(reference)) {
        this.warnedReferences.add(reference);
        this.warn(
          `Warning: ${reference} is shorter than ${MIN_REDACTABLE_LENGTH} characters, so its value is not redacted from output`,
        );
      }
      return;
    }

    const key = `${label}\0${text}`;
    if (this.seenLabels.has(key)) {
      return;
    }
    this.seenLabels.add(key);
    this.secrets.push({ label, forms: encodedForms(text) });
  }

  /** Replace every known secret in `text`, longest first. */
  redact(text: string): string {
    const replacements = this.secrets
      .flatMap((secret) =>
        secret.forms.map((form) => ({ form, label: secret.label })),
      )
      .sort((a, b) => b.form.length - a.form.length);

    let result = text;
    for (const { form, label } of replacements) {
      result = result.split(form).join(`[REDACTED:${label}]`);
    }
    return result;
  }

  /** A copy of `value` with every string inside it redacted. */
  redactDeep<T>(value: T): T {
    return this.walk(value) as T;
  }

  private walk(value: unknown): unknown {
    if (typeof value === "string") {
      return this.redact(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.walk(item));
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          this.redact(key),
          this.walk(item),
        ]),
      );
    }
    return value;
  }
}
