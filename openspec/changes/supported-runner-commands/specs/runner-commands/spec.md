## ADDED Requirements

### Requirement: Direct argument boundaries

The watchdog SHALL derive a literal prompt-file identity from intact argv, preserving whitespace and quotes that are part of an argument. Distinct paths SHALL admit independent runs and duplicate paths SHALL retain BUSY behavior.

#### Scenario: Two prompt filenames sharing a first word

- **WHEN** two synthetic direct Devin runs use distinct prompt-file arguments with spaces while the first run remains alive
- **THEN** both execute, and a concurrent duplicate of the first path returns BUSY

### Requirement: Supported shell invocation

The watchdog SHALL interpret the script argument following supported shell short options containing `c`, including `-c`, `-ec` and `-lc`, without mistaking later argv for source.

#### Scenario: Grouped c flags retain live Codex detection

- **WHEN** a synthetic Codex command prints a configured live spend-cap diagnostic under each supported c-option form
- **THEN** the watchdog emits RATE_LIMIT rather than DONE

### Requirement: Syntax positions and conservative boundaries

The hook and watchdog SHALL classify only supported actual command positions, using maintained parser metadata. The hook SHALL preserve foreign literal/comment/heredoc data and SHALL recognize Codex `exec` after the documented supported global options. Unknown dynamic command names, unknown option grammar and unsupported execution constructs SHALL pass unchanged or have unknown metadata.

#### Scenario: Literal runner text

- **WHEN** echo or printf outputs quoted Pi/Devin/Codex text without invoking a runner
- **THEN** the hook emits no update

#### Scenario: Assignment-looking foreign executable

- **WHEN** the executable is the quoted literal `"X=1"`, directly or after supported nohup, and its arguments contain `pi -p`
- **THEN** the hook emits no update; only supported env operand context consumes assignment operands

#### Scenario: Env separator before assignment operands

- **WHEN** supported env options end with `--` before literal assignment operands and a real Pi command
- **THEN** the hook retains the normal wrapper and Pi extension; `--` ends option scanning without skipping env assignment operands

#### Scenario: Real command after quoted data

- **WHEN** literal runner text precedes an actual supported Pi command
- **THEN** only the real command receives the Pi extension, with other bytes preserved

#### Scenario: Codex global options

- **WHEN** Codex has a verified value-taking or boolean global option before `exec`
- **THEN** the hook wraps it, while help/version and non-exec forms remain unchanged

### Requirement: Literal redirection and cwd metadata

The hook SHALL obtain the runner's actual literal stdout destination from syntax nodes. It SHALL fold successive successful literal `cd ... &&` transitions in order and SHALL leave relative output/prompt paths unknown when the cwd cannot be established.

#### Scenario: Quoted greater-than in a prompt path

- **WHEN** a synthetic Devin prompt contains quoted `>` followed by a real stdout redirect
- **THEN** the returned command watches the real file and detects its refusal before the watchdog ceiling

#### Scenario: Successive relative directory transitions

- **WHEN** `cd first && cd second &&` precedes a redirected synthetic runner
- **THEN** the watch path resolves beneath first/second and its refusal terminates supervision before the ceiling

#### Scenario: Subshell inherits an outer redirect

- **WHEN** a supported subshell contains a synthetic runner and redirects its stdout outside the subshell
- **THEN** the returned command watches the outer file resolved at the outer execution cwd, even after an inner cd, and detects its refusal before the ceiling

#### Scenario: Inner redirect overrides inherited stdout

- **WHEN** that runner has its own stdout redirect after a successful inner literal cd
- **THEN** the returned command watches the inner file at its execution cwd instead of the subshell's outer file
