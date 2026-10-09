# Design

## Context

The watchdog applies mask(string) before formatting its own event diagnostic and verdict. Assignment and colon-value masking currently stop at the first quote, including an escaped quote. Child stdout/stderr are forwarded directly under the existing public contract.

## Goals / Non-Goals

**Goals:** Consume a complete matching quoted secret; preserve its name, surrounding benign text, and the separate raw child-stream contract.

**Non-Goals:** General TOML/JSON/YAML parsing, shell interpretation, new secret-name heuristics, or changes to executor, file-observation or deadline behavior.

## Decisions

Retain the existing masking pipeline and replace only the quoted-value alternatives with escape-aware matching. A backslash consumes the following character as a pair, so escaped quotes stay inside a value while an even backslash pair permits the closing quote. Keep the existing unquoted assignment alternative. No new export or testing seam.

Use one public watchdog table as the primary regression owner. A built-in-only synthetic child prints the unmodified message and writes the error alert into its explicitly supplied owned file. Literal expected guard lines establish both full masking and benign-text preservation.

## Risks / Trade-offs

The supported formats remain bounded quoted strings, not full configuration-language grammars. Existing plain mask tests remain compatibility coverage. A backslash-parity control protects against overly greedy masking of benign suffixes.
