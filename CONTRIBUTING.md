# Contributing

## Setup

```sh
npm ci            # installs tooling and the git hooks (lefthook)
npm run check     # format, typecheck, lint, repo lint, tests
```

agent-runner-guard needs Node 26+ (TypeScript is executed natively). Run it from the
repository root: `node src/watchdog.ts -- <command>`.

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
