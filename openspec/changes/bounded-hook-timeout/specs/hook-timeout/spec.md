# Hook timeout

## ADDED Requirements

### Requirement: Guard ceiling fits the supported outer budget

For a finite positive numeric Bash tool timeout, the hook SHALL derive a positive whole-second guard ceiling while reserving15s for stopping, cleanup and verdict. It SHALL NOT clamp the ceiling upward beyond the available budget. Foreground and background defaults SHALL remain120s and1800s.

#### Scenario: Sufficient explicit budget

- **WHEN** a supported command has timeout20000ms
- **THEN** the returned command has a5s guard ceiling and preserves all other tool input fields

#### Scenario: Whole-second boundary

- **WHEN** timeout is16000ms or16999ms
- **THEN** the returned guard ceiling is1s

#### Scenario: Existing defaults

- **WHEN** a supported command omits timeout
- **THEN** the ceiling is105s in foreground and1785s only when run_in_background is true

### Requirement: Insufficient or nonfinite selected budget passes unchanged

If the selected positive numeric budget is nonfinite or cannot accommodate at least one whole second after the reserve, the hook SHALL produce empty output with successful exit and SHALL add neither guard nor Pi extension. Other existing invalid or missing timeout inputs SHALL retain their fallback policy.

#### Scenario: Short Pi call

- **WHEN** Pi has timeout1500ms,15000ms or15999ms
- **THEN** the command runs unchanged and is unsupervised by this hook

#### Scenario: Nonfinite positive JSON number

- **WHEN** a valid JSON numeric timeout overflows to positive Infinity
- **THEN** no command rewrite is returned

### Requirement: Timing evidence and support claims stay bounded

Documentation SHALL describe a15s scheduling margin without guaranteeing absolute termination timing. Synthetic outer-tool execution SHALL be distinguished from actual Claude tool behavior. Release existence SHALL NOT imply support beyond the latest main branch.

#### Scenario: Supported versions reader

- **WHEN** a reader consults SECURITY after GitHub v0.1.0 exists
- **THEN** it accurately states that only latest main is supported
