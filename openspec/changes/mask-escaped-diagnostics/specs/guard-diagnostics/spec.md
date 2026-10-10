# Guard diagnostics

## Purpose

Define secret masking in guard-owned watchdog diagnostic lines while preserving the independently promised raw child-stream pass-through.

## ADDED Requirements

### Requirement: Complete supported quoted secret masking

The guard SHALL replace the entire single- or double-quoted value after a supported secret-name assignment or colon pair with `***`, treating a backslash and its following character as an escaped pair. It SHALL retain the name and benign surrounding text in its event diagnostic and verdict.

#### Scenario: Escaped quote in an alert message

- **WHEN** an error alert contains a supported quoted secret with an escaped quote and a benign suffix
- **THEN** both the emitted guard event diagnostic and FAILED verdict contain the complete masked value and retain the benign suffix
- **AND** no synthetic secret fragment appears in either guard-owned line

#### Scenario: Escaped backslash before closing quote

- **WHEN** a quoted secret ends with an escaped backslash before its closing quote
- **THEN** the guard masks the value through that closing quote and preserves the text that follows it

### Requirement: Raw child stream preservation

The guard SHALL forward child stdout and stderr unchanged, independently of the masking of guard-owned lines.

#### Scenario: Child prints the same secret-containing alert message

- **WHEN** a synthetic child prints its secret-containing message to stdout and publishes that message as an error alert
- **THEN** child stdout retains the original message while the guard-owned diagnostic and verdict contain the masked form
