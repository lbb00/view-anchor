------------------------- MODULE ViewAnchorProtocol -------------------------
(***************************************************************************)
(* End-to-end formal specification of the view-anchor protocol:            *)
(*   Client/Publisher -> GeometryBatcher -> Network -> ReceiverGuard       *)
(*                                                                         *)
(* Demonstrates that even across an untrusted, reordering, duplicating     *)
(* asynchronous transport channel, the combination of:                     *)
(*   1. Publisher sequence generation                                      *)
(*   2. GeometryBatcher latest-wins coalescing                             *)
(*   3. Receiver GeometrySequenceGuard filtering                           *)
(* guarantees strict causal monotonicity at the receiver and prevents     *)
(* stale geometry regressions.                                             *)
(***************************************************************************)

EXTENDS Integers, Sequences, FiniteSets

CONSTANTS
    Anchors,        \* Set of anchor IDs, e.g. {"a1"}
    MaxGeneration,  \* Maximum generation bound
    MaxSeq          \* Maximum sequence bound

VARIABLES
    pubSeq,             \* Map: anchor -> [placement: Nat, size: Nat] (next sequence to produce)
    batcherPending,     \* Map: anchor -> [g: Nat, p: Int, s: Int, pSeq: Int, sSeq: Int, defined: BOOLEAN]
    network,            \* Set of in-flight messages: [anchor, kind, generation, seq]
    receiverGuard,      \* Map: anchor -> [generation: Nat, pSeq: Int, sSeq: Int, defined: BOOLEAN]
    appliedGeometry     \* Map: anchor -> [pGen: Int, pSeq: Int, sGen: Int, sSeq: Int]

Kinds == {"placement", "size"}
Generations == 0..MaxGeneration
Sequences == 1..MaxSeq
None == -1

TypeOK ==
    /\ pubSeq \in [Anchors -> [Generations -> [placement: 1..(MaxSeq + 1), size: 1..(MaxSeq + 1)]]]
    /\ network \subseteq [anchor: Anchors, kind: Kinds, generation: Generations, seq: Sequences]
    /\ \A a \in Anchors:
        /\ appliedGeometry[a].pGen \in -1..MaxGeneration
        /\ appliedGeometry[a].pSeq \in -1..MaxSeq
        /\ appliedGeometry[a].sGen \in -1..MaxGeneration
        /\ appliedGeometry[a].sSeq \in -1..MaxSeq

Init ==
    /\ pubSeq = [a \in Anchors |-> [g \in Generations |-> [placement |-> 1, size |-> 1]]]
    /\ batcherPending = [a \in Anchors |-> [
            defined |-> FALSE,
            g |-> 0,
            p |-> None,
            s |-> None,
            pSeq |-> None,
            sSeq |-> None
       ]]
    /\ network = {}
    /\ receiverGuard = [a \in Anchors |-> [
            defined |-> FALSE,
            generation |-> 0,
            pSeq |-> None,
            sSeq |-> None
       ]]
    /\ appliedGeometry = [a \in Anchors |-> [
            pGen |-> -1,
            pSeq |-> None,
            sGen |-> -1,
            sSeq |-> None
       ]]

(***************************************************************************)
(* 1. Publisher produces a new measurement and submits to Batcher.         *)
(* Each {anchor, generation} has its own publisher instance with seq       *)
(* starting at 1, matching src/protocol-publisher.ts.                      *)
(***************************************************************************)
Publish(a, g, k) ==
    LET seq == IF k = "placement" THEN pubSeq[a][g].placement ELSE pubSeq[a][g].size IN
    /\ seq <= MaxSeq
    /\ pubSeq' = [pubSeq EXCEPT ![a][g][k] = seq + 1]
    /\ LET st == batcherPending[a] IN
       IF ~st.defined \/ g > st.g THEN
           batcherPending' = [batcherPending EXCEPT ![a] = [
               defined |-> TRUE,
               g |-> g,
               p |-> IF k = "placement" THEN seq ELSE None,
               s |-> IF k = "size" THEN seq ELSE None,
               pSeq |-> None,
               sSeq |-> None
           ]]
       ELSE IF g = st.g THEN
           IF k = "placement" THEN
               IF (st.p = None \/ seq > st.p) /\ (st.pSeq = None \/ seq > st.pSeq) THEN
                   batcherPending' = [batcherPending EXCEPT ![a].p = seq]
               ELSE
                   UNCHANGED batcherPending
           ELSE
               IF (st.s = None \/ seq > st.s) /\ (st.sSeq = None \/ seq > st.sSeq) THEN
                   batcherPending' = [batcherPending EXCEPT ![a].s = seq]
               ELSE
                   UNCHANGED batcherPending
       ELSE
           \* Stale generation: dropped
           UNCHANGED batcherPending
    /\ UNCHANGED <<network, receiverGuard, appliedGeometry>>

(***************************************************************************)
(* 2. Batcher Flushes: pending messages are emitted into the network.      *)
(***************************************************************************)
FlushBatcher ==
    \E a \in Anchors:
        LET st == batcherPending[a] IN
        /\ st.defined
        /\ (st.p # None \/ st.s # None)
        /\ LET pMsg == IF st.p # None THEN {[anchor |-> a, kind |-> "placement", generation |-> st.g, seq |-> st.p]} ELSE {}
               sMsg == IF st.s # None THEN {[anchor |-> a, kind |-> "size", generation |-> st.g, seq |-> st.s]} ELSE {}
               batchMsgs == pMsg \cup sMsg
           IN
           /\ network' = network \cup batchMsgs
           /\ batcherPending' = [batcherPending EXCEPT ![a] = [
                   st EXCEPT
                       !.p = None,
                       !.s = None,
                       !.pSeq = IF st.p # None THEN st.p ELSE st.pSeq,
                       !.sSeq = IF st.s # None THEN st.s ELSE st.sSeq
              ]]
           /\ UNCHANGED <<pubSeq, receiverGuard, appliedGeometry>>

(***************************************************************************)
(* 3. Network Delivers a message to the Receiver.                          *)
(* Note: Messages in network can be processed in ANY order, modeling       *)
(* out-of-order arrival and packet delay. Message is not removed from      *)
(* network to model duplicates / network retransmission.                   *)
(***************************************************************************)
ReceiveMessage(msg) ==
    /\ msg \in network
    /\ LET a == msg.anchor
           g == msg.generation
           k == msg.kind
           s == msg.seq
           curr == receiverGuard[a]
       IN
       IF ~curr.defined \/ g > curr.generation THEN
           \* Accepted: higher generation or initial
           /\ receiverGuard' = [receiverGuard EXCEPT ![a] = [
                   defined |-> TRUE,
                   generation |-> g,
                   pSeq |-> IF k = "placement" THEN s ELSE -1,
                   sSeq |-> IF k = "size" THEN s ELSE -1
              ]]
           /\ appliedGeometry' = [appliedGeometry EXCEPT ![a] = [
                   appliedGeometry[a] EXCEPT
                       ![IF k = "placement" THEN "pGen" ELSE "sGen"] = g,
                       ![IF k = "placement" THEN "pSeq" ELSE "sSeq"] = s
              ]]
           /\ UNCHANGED <<pubSeq, batcherPending, network>>
       ELSE IF g = curr.generation THEN
           LET currSeq == IF k = "placement" THEN curr.pSeq ELSE curr.sSeq IN
           IF s > currSeq THEN
               \* Accepted: higher sequence in same generation
               /\ receiverGuard' = [receiverGuard EXCEPT ![a] = [
                       curr EXCEPT ![IF k = "placement" THEN "pSeq" ELSE "sSeq"] = s
                  ]]
               /\ appliedGeometry' = [appliedGeometry EXCEPT ![a] = [
                       appliedGeometry[a] EXCEPT
                           ![IF k = "placement" THEN "pGen" ELSE "sGen"] = g,
                           ![IF k = "placement" THEN "pSeq" ELSE "sSeq"] = s
                  ]]
               /\ UNCHANGED <<pubSeq, batcherPending, network>>
           ELSE
               \* Rejected: stale sequence
               UNCHANGED <<pubSeq, batcherPending, network, receiverGuard, appliedGeometry>>
       ELSE
           \* Rejected: stale generation
           UNCHANGED <<pubSeq, batcherPending, network, receiverGuard, appliedGeometry>>

(***************************************************************************)
(* Next State Relation                                                     *)
(***************************************************************************)
Next ==
    \/ \E a \in Anchors, g \in Generations, k \in Kinds:
        Publish(a, g, k)
    \/ FlushBatcher
    \/ \E msg \in network:
        ReceiveMessage(msg)

Spec == Init /\ [][Next]_<<pubSeq, batcherPending, network, receiverGuard, appliedGeometry>>

(***************************************************************************)
(* Safety Properties & Invariants                                          *)
(***************************************************************************)

\* 1. Applied Generation Non-Decreasing:
\* For any anchor, the applied placement/size generation never regresses.
AppliedPlacementMonotonicStep(a) ==
    appliedGeometry'[a].pGen >= appliedGeometry[a].pGen /\
    (appliedGeometry'[a].pGen = appliedGeometry[a].pGen =>
        appliedGeometry'[a].pSeq >= appliedGeometry[a].pSeq)

AppliedSizeMonotonicStep(a) ==
    appliedGeometry'[a].sGen >= appliedGeometry[a].sGen /\
    (appliedGeometry'[a].sGen = appliedGeometry[a].sGen =>
        appliedGeometry'[a].sSeq >= appliedGeometry[a].sSeq)

ReceiverMonotonicity ==
    [][\A a \in Anchors:
        /\ AppliedPlacementMonotonicStep(a)
        /\ AppliedSizeMonotonicStep(a)]_appliedGeometry

\* 2. Soundness: Applied geometry was genuinely generated by the publisher for that generation
Soundness ==
    \A a \in Anchors:
        /\ (appliedGeometry[a].pGen # -1 /\ appliedGeometry[a].pSeq # None =>
            appliedGeometry[a].pSeq < pubSeq[a][appliedGeometry[a].pGen].placement)
        /\ (appliedGeometry[a].sGen # -1 /\ appliedGeometry[a].sSeq # None =>
            appliedGeometry[a].sSeq < pubSeq[a][appliedGeometry[a].sGen].size)

=============================================================================
