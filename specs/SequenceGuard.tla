--------------------------- MODULE SequenceGuard ---------------------------
(***************************************************************************)
(* Formal specification of createGeometrySequenceGuard() from              *)
(* src/protocol.ts in view-anchor.                                         *)
(*                                                                         *)
(* The SequenceGuard maintains a generation floor per anchor and sequence  *)
(* high-water marks per message kind ('placement' and 'size') within that  *)
(* generation. It drops late, duplicate, or stale-generation messages.    *)
(***************************************************************************)

EXTENDS Integers, Sequences, FiniteSets

CONSTANTS
    Anchors,        \* Finite set of anchor IDs, e.g. {"a1", "a2"}
    MaxGeneration,  \* Maximum generation for model checking, e.g. 2
    MaxSeq          \* Maximum sequence number for model checking, e.g. 3

VARIABLES
    latest          \* Map: anchor -> [generation: Nat, pSeq: Int, sSeq: Int, defined: BOOLEAN]

NoState == [defined |-> FALSE, generation |-> 0, pSeq |-> -1, sSeq |-> -1]
Kinds == {"placement", "size"}
Generations == 0..MaxGeneration
Sequences == 1..MaxSeq

GuardStates == [
    defined: BOOLEAN,
    generation: Generations,
    pSeq: -1..MaxSeq,
    sSeq: -1..MaxSeq
]

TypeOK ==
    latest \in [Anchors -> GuardStates]

Init ==
    latest = [a \in Anchors |-> NoState]

(***************************************************************************)
(* AcceptMessage models guard.accept(message).                             *)
(* Replicating src/protocol.ts:                                            *)
(*   - if current === undefined || message.generation > current[0] ->      *)
(*       accept and initialize kind sequence, other kind becomes -1        *)
(*   - if message.generation < current[0] -> drop (return false)           *)
(*   - if message.seq <= current[kindSeq] -> drop (return false)           *)
(*   - else -> accept and update current[kindSeq] = message.seq            *)
(***************************************************************************)
AcceptMessage(a, g, k, s) ==
    LET curr == latest[a] IN
    IF ~curr.defined \/ g > curr.generation THEN
        latest' = [latest EXCEPT ![a] = [
            defined |-> TRUE,
            generation |-> g,
            pSeq |-> IF k = "placement" THEN s ELSE -1,
            sSeq |-> IF k = "size" THEN s ELSE -1
        ]]
    ELSE IF g = curr.generation THEN
        LET currSeq == IF k = "placement" THEN curr.pSeq ELSE curr.sSeq IN
        IF s > currSeq THEN
            latest' = [latest EXCEPT ![a] = [
                curr EXCEPT ![IF k = "placement" THEN "pSeq" ELSE "sSeq"] = s
            ]]
        ELSE
            UNCHANGED latest
    ELSE
        UNCHANGED latest

ClearAnchor(a) ==
    latest' = [latest EXCEPT ![a] = NoState]

ClearAll ==
    latest' = [a \in Anchors |-> NoState]

Next ==
    \/ \E a \in Anchors, g \in Generations, k \in Kinds, s \in Sequences:
        AcceptMessage(a, g, k, s)
    \/ \E a \in Anchors:
        ClearAnchor(a)
    \/ ClearAll

Spec == Init /\ [][Next]_latest

(***************************************************************************)
(* Formal Invariants to Verify with TLC                                    *)
(***************************************************************************)

\* High-water marks are always within valid bounds
SeqBounds ==
    \A a \in Anchors:
        latest[a].defined =>
            /\ latest[a].generation \in Generations
            /\ latest[a].pSeq \in -1..MaxSeq
            /\ latest[a].sSeq \in -1..MaxSeq

\* When a generation is initialized, at least the triggering kind has a valid sequence >= 1
ValidInitialization ==
    \A a \in Anchors:
        latest[a].defined =>
            (latest[a].pSeq >= 1 \/ latest[a].sSeq >= 1)

(***************************************************************************)
(* Temporal / Action Properties                                            *)
(* Strict Monotonicity: Whenever an anchor's tracked state evolves within  *)
(* a session (without being cleared), the generation must strictly         *)
(* increase, OR if in the same generation, at least one sequence mark must *)
(* strictly advance without the other regressing.                          *)
(***************************************************************************)
MonotonicStep(a) ==
    (latest[a].defined /\ latest'[a].defined) =>
        \/ latest'[a] = latest[a]
        \/ latest'[a].generation > latest[a].generation
        \/ (latest'[a].generation = latest[a].generation /\
            latest'[a].pSeq >= latest[a].pSeq /\
            latest'[a].sSeq >= latest[a].sSeq /\
            (latest'[a].pSeq > latest[a].pSeq \/ latest'[a].sSeq > latest[a].sSeq))

MonotonicEvolution ==
    [][\A a \in Anchors: MonotonicStep(a)]_latest




=============================================================================
