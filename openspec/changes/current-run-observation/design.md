# Design

Keep the existing prelaunch size/edge mark and add opened-file dev/ino identity. Replacement resets the current-run boundary. Cache opened-file dev/ino, size, mtimeMs and ctimeMs rather than size alone; observe equal-length rewrites whose metadata changes. Recheck regularity on the opened handle and retain bounded tail reads and completed-line live semantics.

Read the final current-run watched text once through the same mark and uncached reader used for live observation. Use those bytes for final live-event detection and rate-limit fallback. A watched exit=N enables failure diagnostics only; it never replaces the supplied command's result. Preserve reserved75–79 result mapping.

Metadata is a practical change observation, not a perfect content revision. A fast same-file overwrite with the same marked prefix can remain indistinguishable from append, and changes with indistinguishable metadata are not promised detected. No hash of the whole file, external log reads or new public opt-in receipt format.

Use the existing public watchdog test owner. G03 checks literal result and absence of new limit state; G11 checks the actual event diagnostic and owned child SIGTERM before a generous ceiling, not merely final WAITING. Synthetic Node children publish ready/write barriers. The public CLI has no observation acknowledgement, so a roomy neutral dwell precedes the same-size rewrite. A healthy rewrite and unrelated Node process provide independent controls. No production test seams.
