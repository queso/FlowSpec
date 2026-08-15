# ADR 0003: flowspec.config.yaml stays committed; ${VAR} is the credential boundary

**Status:** Accepted
**Date:** 2026-08-12
**Deciders:** Face + Sosa, with the project owner (mission: PRD-0006 Pre-Flight Setup Steps)

## Context

PRD-0006 makes `flowspec.config.yaml` the place authentication lives — the shared `setup`
block sits alongside the `baseUrl` it depends on, outside the immutable `specs/**`
surface. That is a deliberate choice, but it creates a new hazard: `flowspec init`
scaffolds the config into the project root and does not gitignore it, so the path of
least resistance becomes scaffold, paste token, commit.

Two mechanisms could close that door, and they point in opposite directions.

## Decision

The config file stays committed. `${VAR}` interpolation is the credential boundary: the
token is referenced from the file and resolved from `process.env` at load time, so the
committed file never contains the secret.

`flowspec init` is not changed to gitignore the config.

## Alternatives Considered

- **Add `flowspec.config.yaml` to `.gitignore` on scaffold.** Rejected. The file's other
  contents — `specsDir`, `baseUrl`, `timeout` — are shared project settings that belong
  in version control precisely so a team runs the same flows the same way. Gitignoring it
  makes those settings uncommittable, and it would defeat interpolation, which exists to
  make committing safe.
- **Do nothing and rely on `--base-url`.** The flag already keeps a token out of files
  entirely, but only for users who find it. Interpolation exists so the ergonomic path
  and the safe path are the same one.

## Consequences

Secrets never enter the file; the file always enters git. Documentation must carry this
weight — README explains `${VAR}` as *the* way to handle tokens, because there is no
mechanical guard preventing a user from pasting a literal one.

Future work on `init` scaffolding or credential ergonomics will reach this fork again.
The choice on record is "secrets never enter the file," not "the file never enters git" —
reopen it only with a plan for the shared settings that would become uncommittable.
