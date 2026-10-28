------------------------------- MODULE Inbox -------------------------------
(***************************************************************************)
(* The inbox and the waker of src/gateway: an event is on disk before the  *)
(* adapter acknowledges it, is logged once, and is decided in the end,     *)
(* also when the process dies at any point and the platform delivers      *)
(* events again.                                                           *)
(*                                                                         *)
(* All events are in one place. When the waker decides is in Debounce.tla; *)
(* here it may decide on its batch at any time, with any reason (the      *)
(* reason depends on the judge and on what the agent works on, which can  *)
(* change between two runs).                                               *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    Events,      \* events on the platform
    Reasons,     \* wake reasons the waker may give
    MaxRepeats,  \* how often the platform may deliver an acknowledged event again (backfill, retries)
    MaxCrashes

VARIABLES
    \* The platform and the adapter
    acked,       \* events the adapter acknowledged
    repeats,     \* deliveries of each event after its acknowledgment
    receiving,   \* in memory: "no", or the receive() call is "storing" or has "stored"
    \* Durable: the bot's SQLite file
    inbox,       \* gw_inbox state: "absent", "new" or "done"
    received,    \* gw_inbox rows in the order they came
    logged,      \* how often each event was written to gw_events
    row,         \* the gw_events row ID of each event, 0 before it is logged
    nextRow,
    decided,     \* events whose gw_events.wake is set
    wakes,       \* wake IDs the agent got; pi-durable keeps one submission per ID
    woken,       \* in how many different wakes each event reached the agent
    \* In memory: lost in a crash
    queue,       \* inbox events waiting to be applied, in order
    batch,       \* the waker's events that wait for a decision
    deciding,    \* decisions in progress: [events, reason, step]
    crashes

vars == <<acked, repeats, receiving, inbox, received, logged, row, nextRow, decided, wakes, woken, queue, batch, deciding, crashes>>

Init ==
    /\ acked = {}
    /\ repeats = [e \in Events |-> 0]
    /\ receiving = [e \in Events |-> "no"]
    /\ inbox = [e \in Events |-> "absent"]
    /\ received = <<>>
    /\ logged = [e \in Events |-> 0]
    /\ row = [e \in Events |-> 0]
    /\ nextRow = 1
    /\ decided = {}
    /\ wakes = {}
    /\ woken = [e \in Events |-> 0]
    /\ queue = <<>>
    /\ batch = {}
    /\ deciding = {}
    /\ crashes = 0

\* The adapter gets an event and calls sink.receive. The platform retries until the event is acknowledged, and may
\* deliver it again later.
Deliver(e) ==
    /\ receiving[e] = "no"
    /\ e \in acked => repeats[e] < MaxRepeats
    /\ repeats' = IF e \in acked THEN [repeats EXCEPT ![e] = @ + 1] ELSE repeats
    /\ receiving' = [receiving EXCEPT ![e] = "storing"]
    /\ UNCHANGED <<acked, inbox, received, logged, row, nextRow, decided, wakes, woken, queue, batch, deciding, crashes>>

\* gateway #receive: log.addInbox, then queue it. A known event ID is dropped.
Store(e) ==
    /\ receiving[e] = "storing"
    /\ IF inbox[e] = "absent"
          THEN /\ inbox' = [inbox EXCEPT ![e] = "new"]
               /\ received' = Append(received, e)
               /\ queue' = Append(queue, e)
          ELSE UNCHANGED <<inbox, received, queue>>
    /\ receiving' = [receiving EXCEPT ![e] = "stored"]
    /\ UNCHANGED <<acked, repeats, logged, row, nextRow, decided, wakes, woken, batch, deciding, crashes>>

\* sink.receive resolved: the adapter acknowledges the event.
Ack(e) ==
    /\ receiving[e] = "stored"
    /\ acked' = acked \cup {e}
    /\ receiving' = [receiving EXCEPT ![e] = "no"]
    /\ UNCHANGED <<repeats, inbox, received, logged, row, nextRow, decided, wakes, woken, queue, batch, deciding, crashes>>

\* log.apply, one inbox event at a time: write the event and mark the inbox row done in one transaction, then give the
\* new event to the waker.
Apply ==
    /\ queue # <<>>
    /\ LET e == Head(queue) IN
        /\ inbox' = [inbox EXCEPT ![e] = "done"]
        /\ logged' = [logged EXCEPT ![e] = @ + 1]
        /\ row' = [row EXCEPT ![e] = nextRow]
        /\ nextRow' = nextRow + 1
        /\ batch' = batch \cup {e}
    /\ queue' = Tail(queue)
    /\ UNCHANGED <<acked, repeats, receiving, received, decided, wakes, woken, deciding, crashes>>

\* The waker's timer fires: the whole batch is decided.
Flush ==
    /\ batch # {}
    /\ \E r \in Reasons : deciding' = deciding \cup {[events |-> batch, reason |-> r, step |-> "deliver"]}
    /\ batch' = {}
    /\ UNCHANGED <<acked, repeats, receiving, inbox, received, logged, row, nextRow, decided, wakes, woken, queue, crashes>>

\* The wake ID is "<reason>:<place>:<row ID of the last event>".
WakeId(d) == <<d.reason, CHOOSE n \in {row[e] : e \in d.events} : \A e \in d.events : row[e] <= n>>

\* target.deliver: the agent gets the wake. The same wake ID is one submission.
DeliverWake(d) ==
    /\ d \in deciding
    /\ d.step = "deliver"
    /\ IF WakeId(d) \in wakes
          THEN UNCHANGED <<wakes, woken>>
          ELSE /\ wakes' = wakes \cup {WakeId(d)}
               /\ woken' = [e \in Events |-> IF e \in d.events THEN woken[e] + 1 ELSE woken[e]]
    /\ deciding' = (deciding \ {d}) \cup {[d EXCEPT !.step = "record"]}
    /\ UNCHANGED <<acked, repeats, receiving, inbox, received, logged, row, nextRow, decided, queue, batch, crashes>>

\* log.setWake.
RecordWake(d) ==
    /\ d \in deciding
    /\ d.step = "record"
    /\ decided' = decided \cup d.events
    /\ deciding' = deciding \ {d}
    /\ UNCHANGED <<acked, repeats, receiving, inbox, received, logged, row, nextRow, wakes, woken, queue, batch, crashes>>

\* The process dies between any two steps. Gateway.start: undecided events go to the waker, then the inbox events that
\* were not applied are queued again, in the order they came.
CrashAndRestart ==
    /\ crashes < MaxCrashes
    /\ crashes' = crashes + 1
    /\ receiving' = [e \in Events |-> "no"]
    /\ batch' = {e \in Events : row[e] > 0 /\ e \notin decided}
    /\ queue' = SelectSeq(received, LAMBDA e : inbox[e] = "new")
    /\ deciding' = {}
    /\ UNCHANGED <<acked, repeats, inbox, received, logged, row, nextRow, decided, wakes, woken>>

Next ==
    \/ \E e \in Events : Deliver(e) \/ Store(e) \/ Ack(e)
    \/ Apply
    \/ Flush
    \/ \E d \in deciding : DeliverWake(d) \/ RecordWake(d)
    \/ CrashAndRestart

\* The platform keeps delivering an event until it is acknowledged, and the gateway keeps working.
Fairness ==
    /\ \A e \in Events : WF_vars(e \notin acked /\ Deliver(e))
    /\ \A e \in Events : WF_vars(Store(e)) /\ WF_vars(Ack(e))
    /\ WF_vars(Apply)
    /\ WF_vars(Flush)
    /\ WF_vars(\E d \in deciding : DeliverWake(d) \/ RecordWake(d))

Spec == Init /\ [][Next]_vars /\ Fairness

TypeOK ==
    /\ acked \subseteq Events
    /\ receiving \in [Events -> {"no", "storing", "stored"}]
    /\ inbox \in [Events -> {"absent", "new", "done"}]
    /\ logged \in [Events -> Nat]
    /\ decided \subseteq Events
    /\ batch \subseteq Events

\* Store before acknowledging: an acknowledged event is on disk.
StoredBeforeAck == \A e \in acked : inbox[e] # "absent"

\* An event the platform delivers twice is logged once.
LoggedOnce == \A e \in Events : logged[e] <= 1

\* Only logged events are decided.
DecidedAreLogged == \A e \in decided : row[e] > 0

\* Not true today, so not in Inbox.cfg. TLC finds it in 9 steps: e1 wakes the agent as "mention", the process dies before
\* log.setWake, and after the restart the agent works on that place again, so e1 is decided as "steer". The wake ID
\* "<reason>:<place>:<last row>" differs, pi-durable sees a new submission, and the agent gets e1 a second time.
\* A new event that joins the group after the restart does the same through the last row ID.
WokenOnce == \A e \in Events : woken[e] <= 1

\* Nothing acknowledged is lost: every acknowledged event is decided in the end.
NothingLost == \A e \in Events : (e \in acked) ~> (e \in decided)

=============================================================================
