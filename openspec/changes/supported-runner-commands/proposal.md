# Supported runner command interpretation

## Why

Joining argv and searching shell text with regular expressions loses prompt-file boundaries, mistakes quoted data for commands/redirections, and resolves chained relative directories incorrectly (G04–G07/G09–G10).

## What Changes

- Preserve direct argv and interpret supported shell scripts through a maintained Bash syntax tree.
- Share runner, literal argument, redirection, source-span and working-directory metadata between the watchdog and Bash hook.
- Support verified Codex global options before `exec` and grouped shell `-c` flags.
- Preserve command bytes and fail conservatively where static interpretation cannot establish an argument or working directory.

## Capabilities

### New Capabilities

- `runner-commands`: bounded static command interpretation for guard admission and hook rewriting.

## Impact

Watchdog classification/lock identity, the Bash hook, a shared production module, public boundary regressions, and the three parser dependencies. Receipt authority, observation, deadlines and other dependency updates remain separate changes.
