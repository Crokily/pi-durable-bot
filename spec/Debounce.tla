------------------------------ MODULE Debounce ------------------------------
(***************************************************************************)
(* The grouping of src/gateway/waker.ts. Per place, the waker waits until  *)
(* Quiet after the last event, but never longer than Max after the first,  *)
(* then decides on the whole group at once. Time is in whole seconds.      *)
(*                                                                         *)
(* Assumption: a timer fires when it is due (a busy process can fire it a  *)
(* little later; the model does not show that delay).                      *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    Places,
    Quiet,      \* settings.debounceMs, in seconds
    Max,        \* settings.debounceMaxMs, in seconds
    MaxEvents,  \* how many events arrive in a behavior
    LastArrival \* events arrive only until this time, so every group is due before the end

ASSUME Quiet > 0 /\ Max >= Quiet

Min(a, b) == IF a < b THEN a ELSE b

NoGroup == [first |-> 0, last |-> 0, n |-> 0]
NoWake == [first |-> 0, last |-> 0, n |-> 0, at |-> 0]

VARIABLES
    now,
    arrived,   \* events so far, in all places
    group,     \* per place: the events that wait (n = 0: none)
    lastWake,  \* per place: the last group the waker decided on (n = 0: none yet)
    decided    \* events in decided groups, in all places

vars == <<now, arrived, group, lastWake, decided>>

Init ==
    /\ now = 0
    /\ arrived = 0
    /\ group = [p \in Places |-> NoGroup]
    /\ lastWake = [p \in Places |-> NoWake]
    /\ decided = 0

Waiting(p) == group[p].n > 0

\* When the timer of a waiting group fires: "Math.min(debounceMs, first + debounceMaxMs - now)" after the last event.
Due(p) == Min(group[p].last + Quiet, group[p].first + Max)

\* Waker.add: the first event of a place starts a group, the next ones join it and move its timer.
Arrive(p) ==
    /\ arrived < MaxEvents
    /\ now <= LastArrival
    /\ arrived' = arrived + 1
    /\ group' = [group EXCEPT ![p] = IF Waiting(p) THEN [@ EXCEPT !.last = now, !.n = @ + 1] ELSE [first |-> now, last |-> now, n |-> 1]]
    /\ UNCHANGED <<now, lastWake, decided>>

\* Waker.#flush: the timer fires and the whole group is decided at once.
Flush(p) ==
    /\ Waiting(p)
    /\ now = Due(p)
    /\ lastWake' = [lastWake EXCEPT ![p] = [first |-> group[p].first, last |-> group[p].last, n |-> group[p].n, at |-> now]]
    /\ decided' = decided + group[p].n
    /\ group' = [group EXCEPT ![p] = NoGroup]
    /\ UNCHANGED <<now, arrived>>

\* A second passes. A due timer fires before the clock moves on. The clock stops once nothing can arrive and nothing
\* waits, so the state space is finite.
Tick ==
    /\ now <= LastArrival + Max
    /\ \A p \in Places : Waiting(p) => now < Due(p)
    /\ now' = now + 1
    /\ UNCHANGED <<arrived, group, lastWake, decided>>

Next == (\E p \in Places : Arrive(p) \/ Flush(p)) \/ Tick

Spec == Init /\ [][Next]_vars /\ WF_vars(Tick) /\ \A p \in Places : WF_vars(Flush(p))

\* While a group waits, the first event is at most Max old and the last at most Quiet old.
WaitLimits == \A p \in Places : Waiting(p) => now - group[p].first <= Max /\ now - group[p].last <= Quiet

\* A group is decided Quiet after its last event, or Max after its first, whichever comes first, and never before.
WakeTiming ==
    \A p \in Places : lastWake[p].n > 0 => lastWake[p].at = Min(lastWake[p].last + Quiet, lastWake[p].first + Max)

\* Groups of a place follow each other: the next group starts no earlier than the last one was decided.
GroupsInOrder == \A p \in Places : Waiting(p) /\ lastWake[p].n > 0 => group[p].first >= lastWake[p].at

RECURSIVE WaitingEvents(_)
WaitingEvents(S) == IF S = {} THEN 0 ELSE LET p == CHOOSE x \in S : TRUE IN group[p].n + WaitingEvents(S \ {p})

\* Every event is in exactly one group: decided, or waiting.
EveryEventOnce == arrived = decided + WaitingEvents(Places)

\* In the end nothing waits.
AllDecided == <>[](\A p \in Places : ~Waiting(p))

=============================================================================
