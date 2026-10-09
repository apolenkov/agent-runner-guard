# Bounded hook timeout

## Why

G08: the hook preserves an outer1500ms deadline but clamps the inner ceiling to30s, contradicting its timing documentation. D01: SECURITY falsely says there are no releases despite GitHub v0.1.0.

## What Changes

- Preserve the15s stop/cleanup/verdict reserve and120s foreground/1800s background defaults.
- Derive a positive whole-second ceiling within valid finite positive tool budgets. Insufficient budgets pass unchanged before adding the guard or Pi extension.
- Fail open for positive nonfinite numeric deadlines instead of emitting a nonfinite ceiling; retain other fallback inputs.
- Document bounded literal command grammar, timing limits and latest-main-only support accurately.

## Capabilities

### New Capabilities

- `hook-timeout`: bounded ceiling or unchanged command at the public hook boundary.

### Modified Capabilities

None.

## Impact

Hook timeout derivation, existing public hook tests, README and SECURITY. No parser, watchdog lifecycle, dependency or supported-version policy change.
