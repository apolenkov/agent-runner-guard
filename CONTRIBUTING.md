# Contributing

## Setup

```sh
npm ci            # installs tooling and the git hooks (lefthook)
npm run check     # format, typecheck, lint, repo lint, tests
```

agent-runner-guard needs Node 26+ (TypeScript is executed natively). Run it from the
repository root: `node src/watchdog.ts -- <command>`.

## Repository layout and publication

- `src/watchdog.ts` is the CLI entry point; `src/hooks/` and `src/harness/` contain
  the optional Claude hook and Pi extension. `test/` contains behavior checks;
  `demo/` contains the public demonstration assets.
- README, CONTRIBUTING and SECURITY describe usage, development and process
  ownership. `openspec/` records requirements and their changes.
- Run the TypeScript directly from the checkout. The private npm manifest is
  tooling configuration: there is no compiled `dist/` product or registry
  publication. Release Please maintains tags, GitHub Releases and CHANGELOG.
- Limit records, task locks and transient alerts belong to
  `~/.local/state/executor-limits` or `EXECUTOR_LIMITS_DIR`, as documented in
  README. Keep runtime state separate from the Git checkout. Worktrees,
  `.superpowers/` process notes and dependencies remain outside tracked source.
- Git source includes the tracked CLI, tests, tooling, documentation and public
  demo assets. Ignore rules do not remove already tracked files; inspect the
  index before declaring an artifact excluded. Preserve unique session handoffs
  in the owner's durable handoff directory outside tracked source.

Check active sessions and worktrees with the coordinator before changing these
boundaries. Assign one owner to each changed file; keep source checks, release
delivery and observed runtime behavior as separate results.

## Rules of the house

- TypeScript at its strictest (`tsconfig.json`), ESLint with no warnings.
- `knip` finds unused files, exports and dependencies; `ls-lint` keeps file names
  in `src/` and `test/` kebab-case.
- Every behaviour has a test under `test/`, named for the file it covers, run by
  `node --test`. Tests spawn real processes; the whole run takes about two minutes.
- [Conventional Commits](https://www.conventionalcommits.org) with a scope:
  `watchdog`, `hook`, `pi-alert`, `devin`, `repo`, `deps`, `ci`, `readme`, `main`.
  Releases are cut by release-please (scope `main` is its PR).
  Git hooks (lefthook) run format and lint on commit, commitlint on the message
  and the full check on push; do not bypass them.

## Dependency holds

- `typescript` stays on 6.x (6.0.3): `typescript-eslint` supports only
  `typescript <6.1`. Take the next TypeScript major once it widens that range;
  drop the Dependabot `ignore` for `typescript` then.
