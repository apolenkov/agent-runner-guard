# Current-run file observation

## Why

Final rate diagnostics can import an old watched 429/exit=1 into a fresh failed run (G03). Live observation caches only file size, missing equal-size refusal rewrites until the ceiling (G11).

## What Changes

- Apply the prelaunch current-run file boundary to both live and final diagnostics.
- Observe file identity and change metadata alongside size, with bounded regular-file reads.
- Clarify watched exit=N as diagnostic input while preserving supplied-command result authority.

## Capabilities

### New Capabilities

- `file-observation`: current-run watched and alert-file observation with conservative filesystem boundaries.

## Impact

Only watchdog observation/diagnostics and its existing public process/file tests change. Command grammar, masking, deadlines, CPU, hooks, dependencies and receipt authority remain outside this package.
