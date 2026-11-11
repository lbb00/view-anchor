--------------------------- MODULE GeometryBatcher ---------------------------
(***************************************************************************)
(* Formal specification of createGeometryBatcher() from                    *)
(* src/protocol-publisher.ts in view-anchor.                               *)
(*                                                                         *)
(* Key properties modeled:                                                 *)
(*   - Microtask coalescing (latest message per kind wins)                 *)
(*   - In-flight batch snapshots during asynchronous/synchronous send()    *)
(*   - Synchronous reentrancy during send() (reentrant publish, clear)     *)
(*   - Object identity checks (state === snapshotStates[index]) protecting *)
(*     against stale updates when clear() or generation upgrade occurs     *)
(*     during an active flush()                                            *)
(*   - Retry semantics on send() failure / rejection                       *)
(***************************************************************************)

EXTENDS Integers, Sequences, FiniteSets

CONSTANTS
    Anchors,        \* e.g. {"a1"}
    MaxGeneration,  \* e.g. 1
    MaxSeq          \* e.g. 2

VARIABLES
    anchors,            \* Map: anchor -> [defined: BOOLEAN, g: Nat, p: Int, s: Int, pSeq: Int, sSeq: Int, id: Nat]
    nextStateId,        \* Monotonically increasing counter for state object identity
    pendingAnchors,     \* Set of anchors with pending messages
    scheduled,          \* BOOLEAN: microtask scheduled
    flushing,           \* BOOLEAN: flush currently executing send()
    inFlightSnapshot,   \* Set of [anchor, kind, generation, seq, stateId]
    deliveredMessages   \* Set of [anchor, kind, generation, seq] delivered to transport

Kinds == {"placement", "size"}
Generations == 0..MaxGeneration
Sequences == 1..MaxSeq
None == -1

NoAnchorState == [
    defined |-> FALSE,
    g |-> 0,
    p |-> None,
    s |-> None,
    pSeq |-> None,
    sSeq |-> None,
    id |-> 0
]

AnchorStates == [
    defined: BOOLEAN,
    g: Generations,
    p: -1..MaxSeq,
    s: -1..MaxSeq,
    pSeq: -1..MaxSeq,
    sSeq: -1..MaxSeq,
    id: Nat
]

TypeOK ==
    /\ anchors \in [Anchors -> AnchorStates]
    /\ nextStateId \in Nat
    /\ pendingAnchors \subseteq Anchors
    /\ scheduled \in BOOLEAN
    /\ flushing \in BOOLEAN
    /\ inFlightSnapshot \subseteq [anchor: Anchors, kind: Kinds, generation: Generations, seq: Sequences, stateId: Nat]
    /\ deliveredMessages \subseteq [anchor: Anchors, kind: Kinds, generation: Generations, seq: Sequences]

Init ==
    /\ anchors = [a \in Anchors |-> NoAnchorState]
    /\ nextStateId = 1
    /\ pendingAnchors = {}
    /\ scheduled = FALSE
    /\ flushing = FALSE
    /\ inFlightSnapshot = {}
    /\ deliveredMessages = {}

(***************************************************************************)
(* Publish(a, g, k, seq): corresponds to batcher.publish(message)          *)
(***************************************************************************)
Publish(a, g, k, seq) ==
    LET st == anchors[a] IN
    IF st.defined /\ g < st.g THEN
        \* Stale generation: dropped
        UNCHANGED <<anchors, nextStateId, pendingAnchors, scheduled, flushing, inFlightSnapshot, deliveredMessages>>
    ELSE IF ~st.defined \/ g > st.g THEN
        \* Upgrade generation or initialize new anchor
        LET newId == nextStateId IN
        /\ nextStateId' = nextStateId + 1
        /\ anchors' = [anchors EXCEPT ![a] = [
                defined |-> TRUE,
                g |-> g,
                p |-> IF k = "placement" THEN seq ELSE None,
                s |-> IF k = "size" THEN seq ELSE None,
                pSeq |-> None,
                sSeq |-> None,
                id |-> newId
           ]]
        /\ pendingAnchors' = pendingAnchors \cup {a}
        /\ scheduled' = TRUE
        /\ UNCHANGED <<flushing, inFlightSnapshot, deliveredMessages>>
    ELSE
        \* Same generation: g = st.g
        IF k = "placement" THEN
            IF (st.p = None \/ seq > st.p) /\ (st.pSeq = None \/ seq > st.pSeq) THEN
                /\ anchors' = [anchors EXCEPT ![a].p = seq]
                /\ pendingAnchors' = pendingAnchors \cup {a}
                /\ scheduled' = TRUE
                /\ UNCHANGED <<nextStateId, flushing, inFlightSnapshot, deliveredMessages>>
            ELSE
                UNCHANGED <<anchors, nextStateId, pendingAnchors, scheduled, flushing, inFlightSnapshot, deliveredMessages>>
        ELSE
            \* Kind is size
            IF (st.s = None \/ seq > st.s) /\ (st.sSeq = None \/ seq > st.sSeq) THEN
                /\ anchors' = [anchors EXCEPT ![a].s = seq]
                /\ pendingAnchors' = pendingAnchors \cup {a}
                /\ scheduled' = TRUE
                /\ UNCHANGED <<nextStateId, flushing, inFlightSnapshot, deliveredMessages>>
            ELSE
                UNCHANGED <<anchors, nextStateId, pendingAnchors, scheduled, flushing, inFlightSnapshot, deliveredMessages>>

(***************************************************************************)
(* StartFlush: Microtask flush (scheduled=TRUE) drains and resets scheduled*)
(***************************************************************************)
MicrotaskFlush ==
    /\ scheduled
    /\ ~flushing
    /\ pendingAnchors # {}
    /\ LET snapshot ==
            { [anchor |-> a, kind |-> "placement", generation |-> anchors[a].g, seq |-> anchors[a].p, stateId |-> anchors[a].id] :
                a \in {x \in pendingAnchors : anchors[x].defined /\ anchors[x].p # None} }
            \cup
            { [anchor |-> a, kind |-> "size", generation |-> anchors[a].g, seq |-> anchors[a].s, stateId |-> anchors[a].id] :
                a \in {x \in pendingAnchors : anchors[x].defined /\ anchors[x].s # None} }
       IN
       /\ snapshot # {}
       /\ flushing' = TRUE
       /\ scheduled' = FALSE
       /\ inFlightSnapshot' = snapshot
       /\ UNCHANGED <<anchors, nextStateId, pendingAnchors, deliveredMessages>>

(***************************************************************************)
(* ExplicitFlush: synchronous flush() invocation; does not clear scheduled *)
(***************************************************************************)
ExplicitFlush ==
    /\ ~flushing
    /\ pendingAnchors # {}
    /\ LET snapshot ==
            { [anchor |-> a, kind |-> "placement", generation |-> anchors[a].g, seq |-> anchors[a].p, stateId |-> anchors[a].id] :
                a \in {x \in pendingAnchors : anchors[x].defined /\ anchors[x].p # None} }
            \cup
            { [anchor |-> a, kind |-> "size", generation |-> anchors[a].g, seq |-> anchors[a].s, stateId |-> anchors[a].id] :
                a \in {x \in pendingAnchors : anchors[x].defined /\ anchors[x].s # None} }
       IN
       /\ snapshot # {}
       /\ flushing' = TRUE
       /\ inFlightSnapshot' = snapshot
       /\ UNCHANGED <<anchors, nextStateId, pendingAnchors, scheduled, deliveredMessages>>

(***************************************************************************)
(* CompleteFlushSuccess: send(batch) succeeded (returned true).            *)
(* Updates pSeq/sSeq and unsets pending p/s IF state identity matches.     *)
(***************************************************************************)
CompleteFlushSuccess ==
    /\ flushing
    /\ LET
        \* Compute updated anchors after applying inFlightSnapshot
        applyMsg(a) ==
            LET st == anchors[a] IN
            IF ~st.defined THEN st
            ELSE
                LET pMatches == {m \in inFlightSnapshot : m.anchor = a /\ m.kind = "placement" /\ m.stateId = st.id}
                    sMatches == {m \in inFlightSnapshot : m.anchor = a /\ m.kind = "size" /\ m.stateId = st.id}
                    newPSeq == IF pMatches # {}
                               THEN LET m == CHOOSE x \in pMatches : TRUE IN
                                    IF st.pSeq = None \/ m.seq > st.pSeq THEN m.seq ELSE st.pSeq
                               ELSE st.pSeq
                    newSSeq == IF sMatches # {}
                               THEN LET m == CHOOSE x \in sMatches : TRUE IN
                                    IF st.sSeq = None \/ m.seq > st.sSeq THEN m.seq ELSE st.sSeq
                               ELSE st.sSeq
                    newP == IF pMatches # {}
                            THEN LET m == CHOOSE x \in pMatches : TRUE IN
                                 IF st.p = m.seq THEN None ELSE st.p
                            ELSE st.p
                    newS == IF sMatches # {}
                            THEN LET m == CHOOSE x \in sMatches : TRUE IN
                                 IF st.s = m.seq THEN None ELSE st.s
                            ELSE st.s
                IN
                [st EXCEPT !.p = newP, !.s = newS, !.pSeq = newPSeq, !.sSeq = newSSeq]
        newAnchors == [a \in Anchors |-> applyMsg(a)]
        newPending == {a \in pendingAnchors : newAnchors[a].defined /\ (newAnchors[a].p # None \/ newAnchors[a].s # None)}
        deliveredNow == { [anchor |-> m.anchor, kind |-> m.kind, generation |-> m.generation, seq |-> m.seq] : m \in inFlightSnapshot }
       IN
       /\ anchors' = newAnchors
       /\ pendingAnchors' = newPending
       /\ deliveredMessages' = deliveredMessages \cup deliveredNow
       /\ flushing' = FALSE
       /\ inFlightSnapshot' = {}
       /\ UNCHANGED <<nextStateId, scheduled>>

(***************************************************************************)
(* CompleteFlushFailure: send(batch) returned false or threw error.        *)
(* Pending messages remain in buffer to be retried on next flush.          *)
(***************************************************************************)
CompleteFlushFailure ==
    /\ flushing
    /\ flushing' = FALSE
    /\ inFlightSnapshot' = {}
    /\ UNCHANGED <<anchors, nextStateId, pendingAnchors, scheduled, deliveredMessages>>

(***************************************************************************)
(* ClearAnchor: batcher.clear(anchorId)                                    *)
(***************************************************************************)
ClearAnchor(a) ==
    /\ anchors' = [anchors EXCEPT ![a] = NoAnchorState]
    /\ pendingAnchors' = pendingAnchors \ {a}
    /\ UNCHANGED <<nextStateId, scheduled, flushing, inFlightSnapshot, deliveredMessages>>

(***************************************************************************)
(* ClearAll: batcher.clear()                                               *)
(***************************************************************************)
ClearAll ==
    /\ anchors' = [a \in Anchors |-> NoAnchorState]
    /\ pendingAnchors' = {}
    /\ UNCHANGED <<nextStateId, scheduled, flushing, inFlightSnapshot, deliveredMessages>>

(***************************************************************************)
(* Next State Relation: models both normal operation and reentrant calls   *)
(* during flushing (where Publish, Clear, etc. can interleave while        *)
(* flushing = TRUE).                                                       *)
(***************************************************************************)
Next ==
    \/ \E a \in Anchors, g \in Generations, k \in Kinds, seq \in Sequences:
        Publish(a, g, k, seq)
    \/ MicrotaskFlush
    \/ ExplicitFlush
    \/ CompleteFlushSuccess
    \/ CompleteFlushFailure
    \/ \E a \in Anchors:
        ClearAnchor(a)
    \/ ClearAll

Spec == Init /\ [][Next]_<<anchors, nextStateId, pendingAnchors, scheduled, flushing, inFlightSnapshot, deliveredMessages>>

(***************************************************************************)
(* Invariants & Verification Properties                                    *)
(***************************************************************************)

\* 1. Valid range of confirmed sequence numbers
ConfirmedSeqBounds ==
    \A a \in Anchors:
        anchors[a].defined =>
            /\ (anchors[a].pSeq # None => anchors[a].pSeq \in Sequences)
            /\ (anchors[a].sSeq # None => anchors[a].sSeq \in Sequences)

\* 2. Temporal Action Property:
\* Within the same state identity (no clear or generation bump), confirmed high-water marks never regress.
ConfirmedSeqStep(a) ==
    (anchors[a].defined /\ anchors'[a].defined /\ anchors[a].id = anchors'[a].id) =>
        /\ (anchors'[a].pSeq >= anchors[a].pSeq)
        /\ (anchors'[a].sSeq >= anchors[a].sSeq)

ConfirmedSeqEvolution ==
    [][\A a \in Anchors: ConfirmedSeqStep(a)]_anchors

\* 3. Pending Messages Are Higher Than Confirmed:
\* If a message is pending for kind k, its sequence must strictly exceed the confirmed high-water mark.
PendingExceedsConfirmed ==
    \A a \in Anchors:
        anchors[a].defined =>
            /\ (anchors[a].p # None /\ anchors[a].pSeq # None => anchors[a].p > anchors[a].pSeq)
            /\ (anchors[a].s # None /\ anchors[a].sSeq # None => anchors[a].s > anchors[a].sSeq)

\* 4. Pending Anchors Consistency:
\* An anchor is in pendingAnchors if and only if it is defined and has at least one pending message.
PendingAnchorsConsistent ==
    \A a \in Anchors:
        (a \in pendingAnchors) <=> (anchors[a].defined /\ (anchors[a].p # None \/ anchors[a].s # None))

\* 5. State Identity Uniqueness:
\* Active anchors have strictly positive and distinct state IDs (or undefined).
StateIdValid ==
    \A a \in Anchors:
        anchors[a].defined => (anchors[a].id > 0 /\ anchors[a].id < nextStateId)

(***************************************************************************)
(* State Constraint for bounded model checking                             *)
(***************************************************************************)
StateConstraint ==
    /\ nextStateId <= 4
    /\ Cardinality(deliveredMessages) <= 4


=============================================================================
