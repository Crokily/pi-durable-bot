------------------------------- MODULE Outbox -------------------------------
(***************************************************************************)
(* The outbox of src/gateway/outbox.ts: one message per send ID, also when *)
(* the process dies at any point.                                          *)
(*                                                                         *)
(* The agent's send tool runs until pi-durable records its result. After a *)
(* crash, pi-durable runs an unfinished tool call again with the same task *)
(* ID, so the outbox gets the same send ID again.                          *)
(*                                                                         *)
(* Assumptions:                                                            *)
(* - findSent is exact: a message the platform accepted is found by its    *)
(*   send ID. (Slack: the adapter reads the channel history.)              *)
(* - One call at a time per send ID (one tool call). A second concurrent   *)
(*   call fails on the primary key of gw_outbox and sends nothing.         *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS SendIds, MaxCrashes

VARIABLES
    outbox,    \* durable: gw_outbox state per send ID, "none", "sending" or "sent"
    platform,  \* the platform: how many messages carry this send ID
    done,      \* durable: pi-durable has the tool's result, so it does not run the call again
    pc,        \* in memory: where the running send call is
    crashes

vars == <<outbox, platform, done, pc, crashes>>

Init ==
    /\ outbox = [s \in SendIds |-> "none"]
    /\ platform = [s \in SendIds |-> 0]
    /\ done = [s \in SendIds |-> FALSE]
    /\ pc = [s \in SendIds |-> "read"]
    /\ crashes = 0

\* log.outbox(sendId): sent -> return it; sending -> a crash left it unclear; nothing -> record "sending" first.
Read(s) ==
    /\ pc[s] = "read"
    /\ pc' = [pc EXCEPT ![s] = CASE outbox[s] = "sent" -> "finish"
                                 [] outbox[s] = "sending" -> "check"
                                 [] OTHER -> "begin"]
    /\ UNCHANGED <<outbox, platform, done, crashes>>

\* log.outboxStart: the intent to send is on disk before the platform hears of it.
Begin(s) ==
    /\ pc[s] = "begin"
    /\ outbox' = [outbox EXCEPT ![s] = "sending"]
    /\ pc' = [pc EXCEPT ![s] = "send"]
    /\ UNCHANGED <<platform, done, crashes>>

\* adapter.findSent: check, then send.
Check(s) ==
    /\ pc[s] = "check"
    /\ pc' = [pc EXCEPT ![s] = IF platform[s] > 0 THEN "record" ELSE "send"]
    /\ UNCHANGED <<outbox, platform, done, crashes>>

\* adapter.send: the platform accepts the message.
PlatformSend(s) ==
    /\ pc[s] = "send"
    /\ platform' = [platform EXCEPT ![s] = @ + 1]
    /\ pc' = [pc EXCEPT ![s] = "record"]
    /\ UNCHANGED <<outbox, done, crashes>>

\* log.outboxDone.
Record(s) ==
    /\ pc[s] = "record"
    /\ outbox' = [outbox EXCEPT ![s] = "sent"]
    /\ pc' = [pc EXCEPT ![s] = "finish"]
    /\ UNCHANGED <<platform, done, crashes>>

\* pi-durable journals the tool's result.
Finish(s) ==
    /\ pc[s] = "finish"
    /\ done' = [done EXCEPT ![s] = TRUE]
    /\ pc' = [pc EXCEPT ![s] = "idle"]
    /\ UNCHANGED <<outbox, platform, crashes>>

\* The process dies between any two steps. On restart pi-durable runs every unfinished send call again.
CrashAndRestart ==
    /\ crashes < MaxCrashes
    /\ crashes' = crashes + 1
    /\ pc' = [s \in SendIds |-> IF done[s] THEN "idle" ELSE "read"]
    /\ UNCHANGED <<outbox, platform, done>>

Step(s) == Read(s) \/ Begin(s) \/ Check(s) \/ PlatformSend(s) \/ Record(s) \/ Finish(s)

Next == (\E s \in SendIds : Step(s)) \/ CrashAndRestart

Spec == Init /\ [][Next]_vars /\ \A s \in SendIds : WF_vars(Step(s))

TypeOK ==
    /\ outbox \in [SendIds -> {"none", "sending", "sent"}]
    /\ platform \in [SendIds -> Nat]
    /\ done \in [SendIds -> BOOLEAN]
    /\ pc \in [SendIds -> {"read", "begin", "check", "send", "record", "finish", "idle"}]
    /\ crashes \in 0..MaxCrashes

\* Never the same message twice.
NoDuplicateSend == \A s \in SendIds : platform[s] <= 1

\* A finished send went out and is recorded.
DoneMeansSent == \A s \in SendIds : done[s] => outbox[s] = "sent" /\ platform[s] = 1

\* Every send goes out in the end, however often the process dies.
EverySendGoesOut == <>(\A s \in SendIds : done[s])

=============================================================================
