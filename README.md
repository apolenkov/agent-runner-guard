<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/banner-dark.svg">
  <img alt="agent-runner-guard: one verdict line for every headless agent run" src=".github/assets/banner-light.svg" width="100%">
</picture>

[![ci](https://github.com/apolenkov/agent-runner-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/apolenkov/agent-runner-guard/actions/workflows/ci.yml)
[![codeql](https://github.com/apolenkov/agent-runner-guard/actions/workflows/codeql.yml/badge.svg)](https://github.com/apolenkov/agent-runner-guard/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/apolenkov/agent-runner-guard/badge)](https://scorecard.dev/viewer/?uri=github.com/apolenkov/agent-runner-guard)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

![Four runs under the guard: DONE, RATE_LIMIT, WAITING and FAILED verdicts](demo/demo.gif)

A guard that wraps headless agent runs: `devin -p`, `pi -p` and `codex exec`.
It starts the command in its own process group, passes the output through,
watches for signs of life and stops only its own group when the run goes silent,
exceeds a ceiling, hits a rate limit or asks for input. The last line of stdout
is always a verdict.

Not published and not packaged: run it straight from a checkout with Node 26+
(TypeScript is executed natively).

## Usage

```sh
node src/watchdog.ts [--silence <sec>] [--max-seconds <sec>] [--watch-file <path>] -- <command> [args...]
```

| Flag                  | Meaning                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `--silence <sec>`     | Seconds without signs of life before the run counts as stalled (default 600)                           |
| `--max-seconds <sec>` | Ceiling on the whole run                                                                               |
| `--watch-file <path>` | File the command writes its output to: growth is life, its tail is scanned for limit and refusal lines |

Output of the command is passed through. Signs of life are checked every 2 s.

## Verdict

The last line of stdout, and the exit code:

| Last line                    | Exit code | Meaning                                              |
| ---------------------------- | --------- | ---------------------------------------------------- |
| `DONE <n>`                   | `n`       | The command finished with code `n` (75-79 become 1)  |
| `RATE_LIMIT <epoch>`         | 75        | Usage or rate limit; reset time as epoch seconds     |
| `STALLED <silence\|ceiling>` | 76        | No signs of life, or the `--max-seconds` ceiling hit |
| `BUSY <pid> <output file>`   | 77        | The same task is already running                     |
| `WAITING <what>`             | 78        | The run waits for input or a tool was refused        |
| `FAILED <why>`               | 79        | Harness error                                        |

## State

Everything lives under `~/.local/state/executor-limits` (override with
`EXECUTOR_LIMITS_DIR`):

- `<executor>` (`devin`, `pi`, `codex`): one line, the epoch when a rate limit
  resets. Written on `RATE_LIMIT`.
- `locks/<sha256 of the task identity>`: keeps a second identical run from
  starting while the first lives. The identity is executor plus `--prompt-file`
  when there is one, otherwise executor plus real cwd plus the command without
  redirections. The lock holds the process group id, the guard pid and the output
  file; it stays alive while the group or the guard does.
- `alerts/<pid>-<uuid>.jsonl`: alert file of one run (directory 0700, file 0600),
  removed when the run ends. Its path is passed to the command in
  `HARNESS_ALERT_FILE`.

Live events (a limit, a tool refusal) are found in output lines, in the
`--watch-file`, and in the alert file written by harness hooks. They stop the
group at once instead of waiting for the command to exit.

## Claude Code hook

`src/hooks/wrap-runner-command.ts` is a PreToolUse hook for the Bash tool. It reads
the hook JSON on stdin; when the command contains `devin -p`, `pi -p` or
`codex exec`, it answers with `updatedInput` that runs the command through the
guard:

```
node '<repo>/src/watchdog.ts' --silence 600 --max-seconds <tool timeout - 15, at least 30> [--watch-file '<redirect target>'] -- bash -c '<command>'
```

The ceiling follows the Bash tool timeout (default 120 s foreground, 30 min in
background), so the guard writes its verdict before the tool cuts the call. When
the command redirects stdout to a file, that file becomes `--watch-file`. The hook
never blocks: any failure, foreign command or missing guard yields empty output
and exit code 0, and the command runs as is.

## Pi extension

`src/harness/pi-alert.ts` is a Pi extension. The hook adds `-e <this file>` to
`pi -p`. When Pi gives up with an error (its own retries exhausted), the extension
appends one JSON line to `$HARNESS_ALERT_FILE`: `rate_limit` if the error text
looks like a limit, otherwise `error`. The guard turns it into `RATE_LIMIT` or
`FAILED`. Without the variable it does nothing.

## Development

```sh
npm install      # tooling and git hooks (lefthook)
npm run check    # format, typecheck, lint, repo lint (knip, ls-lint), tests
```

Tests spawn real processes; the whole run takes about two minutes. Commits follow
[Conventional Commits](https://www.conventionalcommits.org); hooks run format and
lint on commit, commitlint on the message and the full check on push.

The code was extracted with history from a local viewer of agent runs;
`src/devin.ts` holds the few process helpers the guard took with it.

## License

MIT
