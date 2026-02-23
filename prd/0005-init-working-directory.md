# PRD-0005: Init Working Directory Detection

**Author:** Josh
**Date:** 2026-02-21
**Status:** Draft
**Issue:** https://github.com/queso/FlowSpec/issues/4

## Problem Statement

When users run `flowspec init` in a monorepo, the command blindly creates files in the current working directory. If the user is in the repo root instead of their app subdirectory (or vice versa), config files, spec directories, and Claude hook settings end up in the wrong place. The user doesn't discover the mistake until later when `flowspec run` can't find specs or the protection hook doesn't fire.

## Business Context

FlowSpec is a new tool competing for adoption. First-run experience is critical -- if `init` creates files in the wrong spot, users waste time debugging a setup problem before they've even written their first flow. Monorepos (Turborepo, Nx, pnpm workspaces) are increasingly common, making this a likely first encounter for many users.

## Goals & Success Metrics

| Goal | Metric | Target |
|------|--------|--------|
| Reduce init misplacement | Users who need to re-run init after first attempt | Minimize (no baseline yet) |
| Improve first-run clarity | Init command prints clear context about where files will go | 100% of runs show target directory |

## User Stories

- **As a** monorepo developer, **I want** `flowspec init` to detect that I'm in a monorepo root and warn me **so that** I don't accidentally scaffold files in the wrong directory.
- **As a** new FlowSpec user, **I want** to understand what `init` creates and where **so that** I can confidently run it from the right location.
- **As a** developer re-initializing in a project that already has specs, **I want** `init` to find my existing specs directory **so that** new config files are placed alongside them.

## Scope

### In Scope

- Detect monorepo markers (workspace config in package.json, pnpm-workspace.yaml, turbo.json, nx.json) and warn the user if they appear to be at the repo root rather than an app directory
- Search for existing `specs/**/*.flow.yaml` or `flowspec.config.yaml` in the directory tree and use that location as a hint for where to place files
- Print a clear summary of the target directory and what files will be created *before* writing anything
- Add a `--dir` flag to explicitly specify the target directory
- Document `init` behavior in the README (what it creates, where to run it, monorepo guidance)

### Out of Scope

- Interactive directory picker / TUI (keep the CLI simple for now)
- Automatic discovery and init of all apps in a monorepo (users should init each app explicitly)
- Changes to what files `init` creates (that's a separate concern)

## Requirements

### Functional Requirements

1. When `flowspec init` is run, the command shall check the current directory for monorepo markers: `pnpm-workspace.yaml`, `turbo.json`, `nx.json`, or a `workspaces` field in `package.json`.
2. If monorepo markers are found and no `flowspec.config.yaml` or `specs/` directory exists in the current directory, the command shall print a warning suggesting the user may want to run init from an app subdirectory instead.
3. The command shall search upward and downward for existing `flowspec.config.yaml` or `specs/**/*.flow.yaml` files and report their location if found.
4. Before writing any files, the command shall print the target directory and list of files that will be created or modified.
5. A `--dir <path>` CLI option shall allow the user to specify an explicit target directory for init.
6. The README shall include a section documenting what `init` creates, where to run it, and guidance for monorepo setups.

### Non-Functional Requirements

1. The monorepo detection shall add no more than 100ms to the init command (file existence checks only, no heavy parsing).
2. The warning shall be informational, not blocking -- users can proceed if they know what they're doing.

## Edge Cases & Error States

- **User intentionally inits at monorepo root:** The warning is advisory. The command still proceeds. Users who want a single shared specs directory across apps can ignore the warning.
- **Nested monorepo (monorepo within monorepo):** Check only the current directory for markers, don't walk up the tree for monorepo detection.
- **No package.json at all:** Skip monorepo detection entirely. Proceed with normal init.
- **Existing specs in a parent directory:** Report their location so the user knows there's already a FlowSpec setup nearby, but don't refuse to init.
- **`--dir` points to a non-existent path:** Create the directory (same as current behavior with `recursive: true`).

## Dependencies

- None. This is a self-contained improvement to the existing `init` command in `src/init.ts` and the CLI in `src/index.ts`.

## Risks & Open Questions

### Decisions

- Non-blocking warning is sufficient for now. No `--force`/`--yes` flag needed.
- Detect pnpm, Turborepo, and Nx only. Other tools (Lerna, Rush) can be added later if requested.
