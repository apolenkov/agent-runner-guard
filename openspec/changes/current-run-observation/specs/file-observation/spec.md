## ADDED Requirements

### Requirement: Current-run diagnostic boundary

The watchdog SHALL classify watched-file live events and final rate-limit diagnostics only from bytes admitted by its prelaunch current-run mark. Previous appended output SHALL NOT become a failure or limit of the fresh run.

#### Scenario: Old limit and a fresh failure without file output

- **WHEN** an existing watched file contains old 429 and exit=1 and a fresh supplied command exits3 without writing that file
- **THEN** the result is DONE3 with exit3 and no new executor limit state

#### Scenario: Benign current append after an old failure

- **WHEN** a fresh failed command appends only nonlimit text after old 429/exit=1
- **THEN** final diagnostics exclude the old failure and retain the supplied command's result without new limit state

### Requirement: Supplied-command result authority

The watchdog SHALL use the supplied command's exit code for DONE and preserve its reserved75–79 mapping. Arbitrary current-run watched exit=N text SHALL be diagnostic input only and SHALL NOT override this result.

#### Scenario: Watched nested exit text and successful supplied command

- **WHEN** a supplied command writes benign current output followed by exit=7 and exits0
- **THEN** the watchdog returns DONE0 and exit0 without treating the text as a trusted result receipt

### Requirement: Conservative live file change observation

The watchdog SHALL observe opened regular-file identity and change metadata alongside size, so a completed equal-length refusal rewrite with changed metadata can trigger live event stop while the owned runner remains alive. Reads SHALL remain bounded, and only the owned process group SHALL be stopped.

#### Scenario: Equal-size refusal rewrite

- **WHEN** a live synthetic runner overwrites a completed neutral line with an equal-byte-length completed refusal and changes file metadata
- **THEN** the watchdog records an event stop and signals its owned group before the ceiling, leaving an unrelated process alive

#### Scenario: Equal-size healthy rewrite

- **WHEN** the same lifecycle rewrites the neutral line with equal-byte-length healthy text
- **THEN** no refusal is reported and the runner can complete itself with DONE0

#### Scenario: Watched file identity replacement

- **WHEN** the watched path is replaced by another regular file during the owned run
- **THEN** observation does not reuse the prior file's prelaunch boundary merely because its size matches

### Requirement: Explicit filesystem observation limits

The watchdog SHALL preserve conservative regular-file handling and SHALL NOT claim a perfect content version from size or metadata. Fast same-file overwrite with the same marked prefix can remain indistinguishable from append; indistinguishable metadata is also outside guaranteed detection.

#### Scenario: Same-prefix ambiguity

- **WHEN** a fast same-file overwrite preserves the marked edge while producing bytes indistinguishable from append at observation
- **THEN** the documented ambiguity remains rather than promising full overwrite detection
