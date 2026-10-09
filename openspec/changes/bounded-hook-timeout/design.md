# Design

The public PreToolUse hook selects the existing explicit positive numeric timeout or default120000/1800000ms. It then rejects a nonfinite selected timeout and floors seconds minus15. If the result is less than1, it emits an empty successful response before any guard/Pi insertion.16000ms permits1s;20000ms permits5s; defaults remain105/1785s. Existing invalid/missing timeout fallbacks remain.

This is a scheduling margin, not an absolute guarantee against host load, OS scheduling or a real provider deadline. Insufficient calls are unsupervised by this hook. Synthetic outer-tool fixtures own their timeout/cleanup and cannot establish actual Claude deadline behavior.

Primary proof is the existing public hook CLI timeout owner with independent literal boundary/default/control expectations and preserved input fields. A distinct actual command execution fixture records ready/release/signal/termination events for harmless owned Node descendants and an unrelated owned control. RED/failed receipts remain immutable; cleanup uses only exact owned groups. No private production seam, real executor, provider call, HOME remap or documentation source-string test.

Latest-main-only support remains; fresh read-only GitHub metadata verifies release existence. Documentation consistency is reviewed independently.
