# Agent guidance

This repository contains a watchdog for delegated CLI processes. Read
[README.md](README.md), [CONTRIBUTING.md](CONTRIBUTING.md) and
[SECURITY.md](SECURITY.md) before changing process control or reporting.

- Run from the checkout with `node src/watchdog.ts -- <command>`; the tool is not
  published as a registry package. Source lives in `src/`, tests in `test/`.
- Preserve process ownership: the watchdog stops only its own process group.
  Keep the final stdout verdict contract and the distinctions between silence,
  time limit, rate limit and a request for input.
- Use `npm ci` and `npm run check`. Runtime pins live in `.nvmrc` and
  `package.json`. Tests spawn real processes; use synthetic commands and leave no
  task-owned child process running after a check.
- Commit with an allowed scope from CONTRIBUTING, for example `docs(repo): ...`.
  Keep the existing hooks; release-please manages tags and release history.
- Check parallel sessions and worktrees with the coordinator before editing;
  agree file ownership and preserve another session's changes and check inputs.
- Follow CONTRIBUTING's layout and publication boundaries. Runtime locks, alerts
  and limit records belong to the configured state directory. Keep worktrees and
  process notes outside tracked source; preserve unique handoffs durably.
