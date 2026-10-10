# Proposal

## Why

A quoted secret containing an escaped quote leaks its suffix into watchdog event diagnostics and verdicts (G01). Guard-owned diagnostic masking must consume the complete quoted value.

## What Changes

- Recognize escaped quote and backslash pairs in the already supported quoted assignment and colon-value formats.
- Extend the existing watchdog alert-message masking test at the public CLI boundary, including benign-text and raw-child-stdout controls.

## Capabilities

### New Capabilities

- `guard-diagnostics`: Specify the existing guard-owned secret masking boundary, including escaped quoted values and child-stream pass-through.

### Modified Capabilities

None; this checkout has no prior OpenSpec capability files.

## Impact

Only `src/mask.ts` and the existing masking regression in `test/watchdog.test.ts` change. No runtime dependency, public signature or process-supervision behavior changes.
