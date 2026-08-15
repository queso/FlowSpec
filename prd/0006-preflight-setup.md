# PRD-0006: Pre-Flight Setup Steps

**Author:** Josh
**Date:** 2026-08-11
**Status:** Draft
**Issue:** https://github.com/queso/FlowSpec/issues/5

## Problem Statement

Flows cannot run against deployments that require a preliminary navigation to establish
auth. The motivating case is a Shopify Oxygen preview URL, where the auth token is a query
param on the base URL: the browser must visit the base URL first so Shopify can set a
session cookie, after which normal navigation works.

FlowSpec jumps straight to the path in each flow's first `visit` step and never touches the
base URL, so the cookie is never planted. Every flow then fails on a redirect to the login
page:

```text
✗ add-to-cart (1.861s)
  Step 1: click "Crystal Dragon - Fairy Dusk"
  Error: Could not find element with text "Crystal Dragon - Fairy Dusk" on
  "https://accounts.shopify.com/select?rid=b05477ba-..."
```

The failure is also actively misleading. It reports a missing element, pointing the user at
their markup, when the real cause is that the session was never authenticated. Because
`runFlow` opens a fresh browser session per flow, there is currently no place for a user to
express "do this first."

## Business Context

Running against a real preview deployment is the primary way a team would evaluate FlowSpec
on their own app. Password-protected preview environments are the norm on Vercel, Netlify,
and Shopify Oxygen, so this gap blocks the most common trial path. It is also a hard block
rather than a rough edge: there is no workaround short of disabling deployment protection.

## Goals & Success Metrics

| Goal | Metric | Target |
|------|--------|--------|
| Unblock auth-gated deployments | Flows pass against a token-protected preview URL | Works with no spec changes |
| Keep the failure legible | Setup failures distinguishable from spec failures in output | 100% of setup failures labeled as setup |
| Preserve spec immutability | Auth config expressible without editing protected specs | Config-level setup supported |
| Keep credentials out of git | Auth token expressible without writing it into a committed file | `${VAR}` supported in config |

## User Stories

- **As a** developer testing against a protected preview deploy, **I want** to declare a
  navigation that runs before each flow **so that** my auth cookie is planted and my flows
  run against the real app.
- **As a** developer whose app has a login page, **I want** setup to support the full step
  grammar **so that** I can fill credentials and submit, not just visit a URL.
- **As a** developer debugging a failing run, **I want** setup failures reported as setup
  failures **so that** I don't waste time investigating my markup.
- **As a** developer with several flows, **I want** setup applied once in config **so that**
  I don't repeat the same block in every spec file.
- **As a** developer whose preview URL carries a live token, **I want** to reference it as an
  environment variable **so that** committing my config doesn't leak a credential.
- **As a** developer in CI, **I want** a broken shared setup to stop the run immediately
  **so that** I get one clear failure instead of the same error repeated per flow.

## Scope

### In Scope

- An optional `setup` block in `flowspec.config.yaml` applying to every flow
- An optional `setup` block in an individual flow file, overriding the config-level block
- Setup steps reuse the existing step grammar (`visit`, `click`, `fill`, `select`, `wait_for`)
- Setup executes inside the flow's browser session, before the flow's own steps
- Setup failures reported distinctly from step and assertion failures
- Aborting the run when the *shared* config-level setup fails, since it applies to every flow
- `${VAR}` interpolation in `flowspec.config.yaml` string values, resolved from `process.env`
- Documentation in README covering the auth-gated deployment use case

### Out of Scope

- Teardown / after-flow hooks (no demonstrated need yet)
- Sharing one browser session across flows for performance (breaks flow isolation)
- `${VAR}` interpolation inside `specs/**` -- deliberately excluded, see Design
- Reading `.env` files; `process.env` is the single source
- Storing or reusing auth state between runs (Playwright-style `storageState`)
- A CLI flag for setup; this is configuration, not an invocation-time concern
- Fixing `formatAction`'s missing `wait_for` case -- pre-existing, tracked in
  [#11](https://github.com/queso/FlowSpec/issues/11)

## Design

### Where setup executes

`runFlow` (`src/runner.ts:590`) creates one browser session per flow via
`generateSessionName()` and closes it in a `finally`. Setup must run **inside** that session,
immediately before the steps loop at line 601. This is the only placement that plants a
cookie the flow's own steps will see, and it makes session continuity automatic rather than
something the implementation has to arrange.

It also means setup necessarily runs **once per flow**, not once per run. That is a
consequence of per-flow session isolation, not a preference. A shared session would be
faster but would let one flow's state leak into the next, which is contrary to the point of
the tool.

Setup steps reuse `executeStep(step, baseUrl, session, timeout)` unchanged, so `visit` paths
resolve against `baseUrl` exactly as they do in a flow, and `wait_for` and the retry
semantics from PRD-0004 apply without special handling.

### Precedence

A flow-level `setup` **replaces** the config-level block; the two are not merged. Merging
would make the effective setup for any given flow depend on reading two files, and there is
no obvious correct order for concatenation. Replacement is predictable and easy to explain.

An explicit empty list (`setup: []`) in a flow opts that flow out of the config-level setup
entirely -- needed for a flow that tests the unauthenticated state, such as asserting a
redirect to a login page.

### Error reporting

`FlowError.step` is a 0-indexed offset into `flow.steps`. If setup steps reuse that numbering
the output becomes ambiguous, since "Step 0" could mean either the first setup step or the
first spec step. `FlowError` needs a way to say which phase failed -- an optional
`phase: "setup"` discriminator is the smallest change that does this, defaulting to the
current meaning when absent so no existing consumer breaks.

The reporter should then label these distinctly, because "your setup failed" and "your app is
broken" call for completely different responses from the user:

```text
✗ add-to-cart (0.9s)
  Setup step 0: visit "/"
  Error: Could not find element with text "Sign In" on "https://accounts.shopify.com/select"
```

### Environment variable interpolation

Setup is what turns `flowspec.config.yaml` into the place auth lives, so this PRD is what
creates the temptation to commit a token. `flowspec init` scaffolds that file into the project
root and does not add it to `.gitignore`, so the path of least resistance today is: scaffold,
paste token, commit.

Config string values therefore support `${VAR}`, resolved from `process.env` at config-load
time:

```yaml
baseUrl: https://preview.myshopify.dev?_auth=${PREVIEW_TOKEN}
setup:
  - visit: https://preview.myshopify.dev?_auth=${PREVIEW_TOKEN}
```

Four semantics, each chosen against a specific failure mode:

- **Unset variable is a hard error**, raised at config-load time before any browser session
  opens. Substituting an empty string would yield `?_auth=`, a URL that looks correct, fails
  at the deployment, and surfaces as "element not found" -- a new instance of the exact
  misleading-failure class this PRD exists to remove.
- **Applies to all string-valued config fields**, not just `baseUrl`. A carve-out costs the
  same to implement and is harder to document than a uniform rule.
- **`process.env` only, no `.env` parsing.** Bun and Node already load `.env` in common
  setups; a second loader inside FlowSpec would introduce precedence questions and let two
  sources disagree.
- **Not available inside `specs/**`.** Specs are immutable *and* human-readable by design --
  `click: "Place Order"`, not a selector. A spec containing `visible: "${EXPECTED_GREETING}"`
  would mean the assertion depends on the environment it runs in, so reading the file would
  no longer tell you what the app should do. That trades away more of the premise than it
  buys.

Note that `--base-url` already overrides config and can keep a token out of files entirely.
Interpolation exists so the *ergonomic* path and the *safe* path are the same one, rather
than relying on users finding the flag.

### Aborting on shared setup failure

A failing setup step does not retry -- step execution has no retry by design (PRD-0004 scoped
retry to assertions), so only `wait_for` consumes the timeout. What every flow pays regardless
is a fresh browser session launch, roughly a second. A broken shared setup across ten flows
therefore costs ten identical error messages and ~10s in the common case, or 10 x timeout when
setup uses `wait_for`.

When the failing setup came from `flowspec.config.yaml` it applies to every flow, so the run
aborts and the remaining flows are reported as skipped. When it came from a flow's own `setup`
block the failure stays local: flow-level setup differs per flow, so one flow's setup failing
says nothing about the next one's. Aborting on *any* setup failure would stop flows that would
have passed.

This requires a third state in `formatSummary` (`src/reporter.ts:89`), which today reports only
`passed` and `failed`. There is precedent for ending a run early: parse errors already exit
with code 2 before any flow runs.

### Spec immutability

Files under `specs/**/*.flow.yaml` are protected by the PreToolUse hook; `flowspec.config.yaml`
is not. This is the main reason to support setup in both places. Auth setup naturally belongs
in config, alongside the `baseUrl` it depends on and outside the immutable surface. Flow-level
setup is for cases where the setup is genuinely part of the behavior being specified.

### Silent-ignore hazard

`FlowSpecSchema` (`src/types.ts:66`) is not `.strict()` at the top level -- unknown keys are
currently accepted and dropped. A user who writes a `setup:` block today gets no error and no
behavior. Whatever the resolution, `setup` must be a real schema field rather than relying on
passthrough, or flows will silently not run their setup.

`mergeConfig` (`src/config.ts:120`) rebuilds its return value field by field and will drop a
new `setup` key unless updated. This is an easy omission to make and would present as setup
silently not running when configured.

## Requirements

### Functional Requirements

1. `FlowSpecConfigSchema` shall accept an optional `setup` field: an array of steps using the
   existing `FlowStepSchema`.
2. `FlowSpecSchema` shall accept an optional `setup` field of the same type.
3. `mergeConfig` shall carry `setup` through from the config file.
4. `runFlow` shall execute setup steps in the flow's browser session, before the flow's own
   steps, using the same `baseUrl` and `timeout`.
5. A flow-level `setup` shall replace, not merge with, a config-level `setup`.
6. A flow-level `setup: []` shall suppress the config-level setup for that flow.
7. When a setup step fails, `runFlow` shall return `success: false` with a `FlowError` marked
   as originating in the setup phase, carrying the failing step index and action.
8. The reporter shall render setup failures distinctly from step failures.
9. When a setup originating from `flowspec.config.yaml` fails, the run shall stop and the
   remaining flows shall be reported as skipped.
10. When a setup originating from a flow's own `setup` block fails, only that flow shall fail
    and the run shall continue.
11. `formatSummary` shall report a skipped count alongside passed and failed.
12. Config string values shall support `${VAR}`, substituted from `process.env` at
    config-load time.
13. A `${VAR}` reference with no corresponding environment variable shall raise an error
    naming the missing variable and the config file, before any browser session opens.
14. Interpolation shall not be applied to files under `specs/**`.
15. A flow with no setup configured at either level shall behave exactly as it does today,
    including its `duration` accounting.
16. README shall document `setup` with the auth-gated preview deployment as the worked
    example, and document `${VAR}` as the way to keep tokens out of committed files.

### Non-Functional Requirements

1. Setup shall add no measurable overhead to flows that do not configure it (no extra browser
   commands, no additional session round-trips).
2. Setup step failures shall not be retried beyond the existing per-step semantics; a broken
   setup should fail fast rather than multiply the timeout across every flow in the run.
3. Interpolation errors shall name the missing variable, not merely report that config parsing
   failed.

## Edge Cases & Error States

- **Shared setup fails on the first flow:** The run aborts. The first flow reports a
  setup-phase failure; the rest are counted as skipped, not failed, since they never ran.
- **Flow-level setup fails:** Only that flow fails. Subsequent flows still run, including any
  that rely on the shared config-level setup.
- **A run where every flow has its own setup and all of them fail:** Every flow fails
  independently and the run completes. No abort, because no shared setup was involved.
- **`${VAR}` referenced but unset:** Config load fails with an error naming the variable. No
  flows run, and no browser session opens.
- **`${VAR}` appearing inside a spec file:** Left literal. A spec asserting `visible: "${FOO}"`
  looks for that exact text, which is the correct reading of an immutable, literal spec.
- **A literal `${` in a config value that is not a variable reference:** Needs a defined
  escape or a precise enough match pattern that it is left alone.
- **Setup step references an element that needs the app to be up:** No special handling; the
  failure surfaces as a setup error, which is the correct signal.
- **`setup` present in a flow file but empty:** Treated as an explicit opt-out (FR-6), not as
  "no setup configured."
- **`setup` in config but the flow's first step is an absolute URL:** Setup still runs. The
  cookie is planted on the base URL's domain; whether it applies to the absolute URL is the
  browser's business, not FlowSpec's.
- **Malformed step inside `setup`:** Rejected at parse/config-load time with the same error
  path as a malformed step in `steps`, before any browser session opens.
- **Config-level setup with no `baseUrl` set:** Relative `visit` paths resolve against the
  default `http://localhost:3000`, consistent with existing behavior.

## Dependencies

- Builds on the runner and retry infrastructure from PRD-0002 and PRD-0004.
- Touches `src/types.ts`, `src/config.ts`, `src/runner.ts`, `src/index.ts`, `src/reporter.ts`,
  and the README.
- No new packages.
- Related but independent: [#11](https://github.com/queso/FlowSpec/issues/11), the missing
  `wait_for` case in `formatAction`. Not a blocker, but until it lands a failing `wait_for`
  in a `setup` block will print `Step N: unknown action`.

## Verification

1. `bun run test` -- new coverage for: setup executes before steps; flow-level overrides
   config-level; `setup: []` opts out; setup failure produces a setup-phase error; no-setup
   flows unchanged.
2. A browser-level test proving session continuity -- that state established during setup is
   visible to the flow's own steps. This is the requirement most likely to be satisfied
   "green" by an implementation that actually opens a second session, so it deserves a real
   test rather than a unit assertion on wiring.
3. Abort behavior covered in both directions: a shared config-level setup failure stops the
   run and marks the rest skipped; a flow-level setup failure does not.
4. Interpolation covered for: substitution from `process.env`; unset variable raising a named
   error before any session opens; spec files left uninterpolated.
5. `bun run typecheck` and `bun run lint` clean.
6. Manual verification against a token-protected preview deployment.

## Decisions

- Setup runs per flow, inside the flow's session. Dictated by session isolation, not preference.
- Flow-level setup replaces config-level rather than merging; `setup: []` is an explicit opt-out.
- Setup reuses the full step grammar rather than being restricted to `visit`, since login
  flows are a stated use case and it requires no new grammar.
- `${VAR}` interpolation ships as part of this PRD rather than as a follow-up, so the
  ergonomic path and the safe path are the same one. Semantics are strict and config-only:
  hard error on unset, all string config fields, `process.env` only, never inside `specs/**`.
- A shared config-level setup failure aborts the run; a flow-level setup failure does not,
  because flow-level setup differs per flow and one failure does not predict the next.
- The `formatAction` / `wait_for` gap is a pre-existing defect and ships separately as
  [#11](https://github.com/queso/FlowSpec/issues/11), keeping this PRD scoped to setup.
