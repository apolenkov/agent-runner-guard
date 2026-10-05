# Security policy

## Supported versions

agent-runner-guard has no releases; only the latest `main` is supported.

## Reporting a vulnerability

Please report privately through
[GitHub Security Advisories](https://github.com/apolenkov/agent-runner-guard/security/advisories/new).
Do not open a public issue. You will get an answer within 7 days.

## What agent-runner-guard does on your machine

It starts the command you give it in its own process group and passes the
output through. It stops, with SIGTERM and then SIGKILL, only that group: when
the run goes silent, exceeds the ceiling, hits a rate limit or asks for input.
To watch the group it runs `ps` and `lsof` (no shell), and for Devin it reads
the modification time of the Devin CLI log in `~/.local/share/devin/cli/logs`.
With `--watch-file` it reads the tail of that file.

It writes only under `~/.local/state/executor-limits` (or `EXECUTOR_LIMITS_DIR`),
in directories with mode 0700 and files with mode 0600: the reset time of a rate
limit per executor, a lock per running task (process group id, guard pid, output
file) and a per-run alert file, removed when the run ends. The verdict line
masks keys, tokens and passwords in the text it quotes.

The optional hook rewrites a `devin -p`, `pi -p` or `codex exec` command to run
through the guard and never blocks one. Its Pi extension appends one JSON line
to `$HARNESS_ALERT_FILE` when Pi gives up with an error.

No network: the code makes no connections, sends no telemetry and keeps nothing
outside the state directory.
