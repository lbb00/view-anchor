# Formal Verification with TLA+

`view-anchor` provides high-performance geometry synchronization between DOM elements and external surfaces across asynchronous, possibly untrusted or distributed transport boundaries (such as Web Workers, iframes, WebSockets, or React render cycles).

To formally prove that the synchronization protocol never causes visual regressions, out-of-order updates, or race-condition corruptions, the core protocol and batching logic are specified and verified using **TLA+** (Temporal Logic of Actions) and the **TLC Model Checker**.

---

## Verified Specifications

The formal specifications reside in the [`specs/`](./) directory:

| Specification                                        | Target Component                                                              | Formal Properties & Invariants                                                                                                 |
| ---------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [`SequenceGuard.tla`](./SequenceGuard.tla)           | `createGeometrySequenceGuard()` in `src/protocol.ts`                          | `TypeOK`, `SeqBounds`, `ValidInitialization`, `MonotonicEvolution`                                                             |
| [`GeometryBatcher.tla`](./GeometryBatcher.tla)       | `createGeometryBatcher()` in `src/protocol-publisher.ts`                      | `TypeOK`, `ConfirmedSeqBounds`, `PendingExceedsConfirmed`, `PendingAnchorsConsistent`, `StateIdValid`, `ConfirmedSeqEvolution` |
| [`ViewAnchorProtocol.tla`](./ViewAnchorProtocol.tla) | End-to-end distributed system (`Publisher -> Batcher -> Network -> Receiver`) | `TypeOK`, `Soundness`, `ReceiverMonotonicity`                                                                                  |

Run `pnpm tla:check` to execute TLC model checking across all specifications and view live explored state counts.

---

## Core Invariants & Safety Guarantees

### 1. Causal Monotonicity (`MonotonicEvolution`, `ReceiverMonotonicity`)

- **Generation Safety**: A message from an older generation than currently tracked is always rejected.
- **Sequence Monotonicity**: For a given anchor and generation, updates for `placement` and `size` independently strictly advance high-water marks.
- **Channel Invariance**: Even when the underlying network reorders packets or duplicates batches, the receiver geometry is strictly monotonic and never displays a stale bounding box or size.

### 2. Batcher Reentrancy & Isolation (`ConfirmedSeqEvolution`, `StateIdValid`)

- **Microtask Coalescing**: Multiple publications in the same JavaScript turn are coalesced; latest-wins per kind.
- **In-Flight Snapshot Isolation**: When `flush()` sends a batch to a transport callback, synchronous reentrant `publish()` or `clear()` calls do not corrupt the in-flight state.
- **Object Identity Guard**: A reentrant generation upgrade or anchor clear swaps the anchor's state object reference. When `send()` returns, the completed snapshot skips anchors whose state identity changed, preventing stale high-water marks from resurrecting or corrupting newer generations.
- **Failure Resiliency**: If `send()` fails or throws, pending messages remain buffered and are retried on the next flush.

---

## Model-Based Conformance & Anti-Drift Protection

To ensure the production TypeScript implementation never drifts from the TLA+ specifications as the codebase evolves, the project includes an automated **Model-Based Property & Conformance Testing** suite powered by `fast-check` in [`test/protocol-conformance.test.ts`](../test/protocol-conformance.test.ts):

- **TLA+ Oracle Driven**: Generates hundreds of chaotic, randomized operation sequences (concurrent publishes, random generation jumps, synchronous reentrant `flush()` / `clear()`, simulated transport errors, and network packet delays/reordering/duplication/drops).
- **Runtime Invariant Assertions**: Validates that the real TypeScript code continuously satisfies the exact TLA+ safety invariants (`MonotonicityWithinEpoch`, `PendingExceedsConfirmed`, `ReentrancyPreservation`, `GenerationIsolation`, `ReceiverMonotonicity`, and `Soundness`).
- **Continuous Integration**: Runs automatically on every `pnpm test` execution. Any code modification that deviates from the formal specification fails the test suite instantly.

---

## Running Verification

### Prerequisites

A Java Runtime Environment (JRE/JDK 11+) is required to execute the TLC model checker.

Verify Java is available:

```bash
java -version
```

### Run Model Checking

Run all specifications via npm / pnpm:

```bash
pnpm run tla:check
```

Or run via the Node runner directly:

```bash
node scripts/verify-tla.js
```

### Run a Single Specification

```bash
pnpm run tla:check --spec SequenceGuard
pnpm run tla:check --spec GeometryBatcher
pnpm run tla:check --spec ViewAnchorProtocol
```

### Clean Cache and States

```bash
pnpm run tla:clean
```

---

## CI / CD Integration

TLA+ model checking runs automatically in GitHub Actions CI on every pull request and push to `main` via the `tla-verification` job in `.github/workflows/ci.yml`.
