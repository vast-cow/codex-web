# Separate proposal: isolated two-write credit-floor experiment

Status: reviewable code-level proposal only. **Not implemented, tested as a runtime change, or deployed.** The running service is normal with diagnostics disabled. This proposal changes no ACK path or writer promise.

For an isolated host candidate pinned to Desktop 26.1007.30912, the sole behavioral edit is:

```diff
 // startup-requirements-C6B1x9gL.js: adaptive RPC window constants (semantic excerpt)
-et=262144,tt=1073741824,nt=65536,rt=2,it=1.25,at=.9,ot=3
+et=262144,tt=1073741824,nt=524288,rt=2,it=1.25,at=.9,ot=3
```

This is an excerpt for code review, not a directly applicable unified patch to the minified physical line. `et` is initial credit, `tt` maximum, `nt` minimum. Initial credit remains 262,144; the new minimum takes effect at the existing ACK-driven clamp (the first-ACK initialization branch does not clamp). The browser bundle stays unchanged. The remaining rate/RTT calculation, startup exit, atomic-send check, `onError`, `close`, `abort`, and ACK-after-writer-settlement behavior remain unchanged.

Two typical writes consume 524,808 estimated bytes. Atomic overshoot means a floor of 524,288 allows both writes and then blocks. This isolates the capacity hypothesis without inventing a new parallel producer or acknowledging unconsumed data. It does not make the adaptive controller optimal, nor establish a production minimum.

If authorized for a later experiment, implement the edit in a separate fail-closed candidate builder using the TypeScript AST, in the style of `scripts/diagnostics/instrument-rpc.cjs`. Verify the `st` class uses `nt` as its minimum, the exact initializer is 65536, and there is exactly one matching host declaration before writing. Reject unknown bundle versions and source/symlink/hard-linked live directories. Copy candidate artifacts, regenerate compressed siblings as appropriate, record before/after hashes, and preserve an unmodified control. Do not modify the ordinary preparation pipeline or default deployed constants for the experiment.

This host-wide constant affects every host RPC window in B, not just bootstrap. That scope is acceptable only in an isolated controlled trial with concurrent-stream validation; production adoption would need a deliberate stream-policy scope or independent evidence for all traffic. Never select stream 7/window 803/session 802 at runtime: those IDs are transient. Do not add a bootstrap classifier, a new hard cap, and a rate-filter change to the same A/B treatment.

Run the correctness/resource acceptance gates in [the A/B plan](analysis.md#controlled-ab-plan). Existing window-equivalence tests compare instrumented and original behavior and do not by themselves establish that a larger floor is safe. Test the altered extracted RPC core explicitly, particularly stopped consumers, cancel with credit pending, failed writer rejection, large-write overshoot, and multiple concurrent streams. Keep the experiment's 1-MiB flight abort guard outside the data path so the only performance variable is the minimum.

Reject the proposal if the added flight only increases queuing, RTT, cancellation backlog or resident memory. No runtime patch has been produced because no performance implementation or deployment was requested; this document defines the exact proposed edit and the work required before any trial.
