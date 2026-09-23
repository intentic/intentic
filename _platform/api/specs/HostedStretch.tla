--------------------------- MODULE HostedStretch ---------------------------
(***************************************************************************)
(* The awake-hour meter of ONE hosted machine: its Fly state, its          *)
(* HostedMachine row, the row's `wokeAt` column, and every path that       *)
(* opens or closes the stretch that column holds (hosted-usage.ts and its  *)
(* callers). A stretch is an id, not a duration: the properties are about  *)
(* which stretches reach hostedUsage, and how many times. Each shared step *)
(* is one transaction holding the row lock, so it is one atomic action.    *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
    Wakes   \* concurrent `wake` requests, each one-shot

None == 0
\* Stretch 1 predates the model; each wake mints at most one more.
Stretches == 1..(1 + Cardinality(Wakes))
Procs == Wakes \cup {"meter", "abuse", "idle", "trash"}

VARIABLES
    fly,              \* the machine as Fly holds it
    row,              \* whether the HostedMachine row exists
    wokeAt,           \* the stretch the row holds open, None when closed
    nextId,           \* the id the next open mints
    charged,          \* per stretch: how many times chargeMinutes added it
    pc,               \* per process: its next step
    snap,             \* per process: the wokeAt it read
    destroyedRunning  \* the idle sweep destroyed a machine Fly had running

vars == <<fly, row, wokeAt, nextId, charged, pc, snap, destroyedRunning>>

TypeOK ==
    /\ fly \in {"stopped", "running", "gone"}
    /\ row \in BOOLEAN
    /\ wokeAt \in {None} \cup Stretches
    /\ nextId \in 2..(Cardinality(Stretches) + 1)
    /\ charged \in [Stretches -> Nat]
    /\ snap \in [Procs -> {None} \cup Stretches]
    /\ destroyedRunning \in BOOLEAN
    /\ ~row => wokeAt = None

Init ==
    /\ nextId = 2
    /\ row = TRUE
    /\ pc = [p \in Procs |-> "idle"]
    /\ snap = [p \in Procs |-> None]
    /\ destroyedRunning = FALSE
    /\ \/ fly = "running" /\ wokeAt = 1 /\ charged = [s \in Stretches |-> 0]
       \/ fly = "stopped" /\ wokeAt = 1 /\ charged = [s \in Stretches |-> 0]
       \/ fly = "stopped" /\ wokeAt = None /\ charged = [s \in Stretches |-> IF s = 1 THEN 1 ELSE 0]

Charge(s) == IF s = None THEN charged ELSE [charged EXCEPT ![s] = @ + 1]
Goto(p, l) == pc' = [pc EXCEPT ![p] = l]
Keep(p, v) == snap' = [snap EXCEPT ![p] = v]

(***************************************************************************)
(* Shared steps.                                                           *)
(***************************************************************************)

\* closeHostedStretch: closes and charges the stretch the process read, only while the row still holds it.
Close(p, next) ==
    /\ IF row /\ snap[p] # None /\ wokeAt = snap[p]
          THEN wokeAt' = None /\ charged' = Charge(snap[p])
          ELSE UNCHANGED <<wokeAt, charged>>
    /\ Goto(p, next)
    /\ UNCHANGED <<fly, row, nextId, snap, destroyedRunning>>

\* dropHostedMachine: deletes the row, charging whatever stretch it holds at that moment.
Forget(p, next) ==
    /\ row' = FALSE
    /\ wokeAt' = None
    /\ charged' = IF row THEN Charge(wokeAt) ELSE charged
    /\ Goto(p, next)
    /\ UNCHANGED <<fly, nextId, snap, destroyedRunning>>

(***************************************************************************)
(* wake (sandbox.routes.ts): read the row, settleHostedStretch, wakeHosted,*)
(* then openStretchOrStop. Any browser that loses the daemon calls it.     *)
(***************************************************************************)

WakeRead(w) ==
    /\ pc[w] = "idle"
    /\ IF row THEN Keep(w, wokeAt) /\ Goto(w, "settle") ELSE UNCHANGED snap /\ Goto(w, "done")
    /\ UNCHANGED <<fly, row, wokeAt, nextId, charged, destroyedRunning>>

\* A closed column returns before asking Fly; a live or unreachable machine leaves it open.
WakeSettle(w) ==
    /\ pc[w] = "settle"
    /\ \/ Goto(w, "start")
       \/ snap[w] # None /\ fly \in {"stopped", "gone"} /\ Goto(w, "close")
    /\ UNCHANGED <<fly, row, wokeAt, nextId, charged, snap, destroyedRunning>>

WakeClose(w) == pc[w] = "close" /\ Close(w, "start")

\* A refused start on a live machine reads as success, so only a stopped one can fail.
WakeStart(w) ==
    /\ pc[w] = "start"
    /\ \/ fly = "gone" /\ UNCHANGED fly /\ Goto(w, "forget")
       \/ fly # "gone" /\ fly' = "running" /\ Goto(w, "open")
       \/ fly = "stopped" /\ UNCHANGED fly /\ Goto(w, "done")
    /\ UNCHANGED <<row, wokeAt, nextId, charged, snap, destroyedRunning>>

\* forgetHostedMachine, on a machine Fly no longer has.
WakeForget(w) == pc[w] = "forget" /\ Forget(w, "done")

\* openHostedStretch: charges the stretch the row still holds and opens the next; no row means "undo".
WakeOpen(w) ==
    /\ pc[w] = "open"
    /\ IF row
          THEN /\ wokeAt' = nextId
               /\ nextId' = nextId + 1
               /\ charged' = Charge(wokeAt)
               /\ Goto(w, "done")
          ELSE /\ UNCHANGED <<wokeAt, nextId, charged>>
               /\ Goto(w, "undo")
    /\ UNCHANGED <<fly, row, snap, destroyedRunning>>

\* The stop openStretchOrStop issues for a machine it started with no row left to bill it.
WakeUndo(w) ==
    /\ pc[w] = "undo"
    /\ fly' = IF fly = "running" THEN "stopped" ELSE fly
    /\ Goto(w, "done")
    /\ UNCHANGED <<row, wokeAt, nextId, charged, snap, destroyedRunning>>

(***************************************************************************)
(* meter (hosted-meter.ts): settleHostedStretches every tick, under        *)
(* JOB_HOSTED_METER, so one pass at a time.                                *)
(***************************************************************************)

MeterRead ==
    /\ pc["meter"] = "idle"
    /\ row /\ wokeAt # None
    /\ Keep("meter", wokeAt)
    /\ Goto("meter", "settle")
    /\ UNCHANGED <<fly, row, wokeAt, nextId, charged, destroyedRunning>>

MeterSettle ==
    /\ pc["meter"] = "settle"
    /\ \/ Goto("meter", "idle")
       \/ fly \in {"stopped", "gone"} /\ Goto("meter", "close")
    /\ UNCHANGED <<fly, row, wokeAt, nextId, charged, snap, destroyedRunning>>

MeterClose == pc["meter"] = "close" /\ Close("meter", "idle")

(***************************************************************************)
(* abuse (hosted-abuse.ts): stop a machine at full load, close at now.     *)
(***************************************************************************)

AbuseRead ==
    /\ pc["abuse"] = "idle"
    /\ row /\ fly = "running"
    /\ Keep("abuse", wokeAt)
    /\ Goto("abuse", "stop")
    /\ UNCHANGED <<fly, row, wokeAt, nextId, charged, destroyedRunning>>

AbuseStop ==
    /\ pc["abuse"] = "stop"
    /\ IF fly = "gone" THEN UNCHANGED fly /\ Goto("abuse", "done") ELSE fly' = "stopped" /\ Goto("abuse", "close")
    /\ UNCHANGED <<row, wokeAt, nextId, charged, snap, destroyedRunning>>

AbuseClose == pc["abuse"] = "close" /\ Close("abuse", "done")

(***************************************************************************)
(* idle (hosted-idle.ts decideIdleMachine): forget a machine Fly lost;     *)
(* destroy one stopped past its deadline, then forget it.                  *)
(***************************************************************************)

IdleRead ==
    /\ pc["idle"] = "idle"
    /\ row
    /\ Goto("idle", "settle")
    /\ UNCHANGED <<fly, row, wokeAt, nextId, charged, snap, destroyedRunning>>

\* Not due, still running, or getMachine failed: the machine is kept.
IdleSettle ==
    /\ pc["idle"] = "settle"
    /\ \/ Goto("idle", "done")
       \/ fly = "gone" /\ Goto("idle", "forget")
       \/ fly = "stopped" /\ Goto("idle", "destroy")
    /\ UNCHANGED <<fly, row, wokeAt, nextId, charged, snap, destroyedRunning>>

IdleDestroy ==
    /\ pc["idle"] = "destroy"
    /\ fly' = "gone"
    /\ destroyedRunning' = (destroyedRunning \/ fly = "running")
    /\ Goto("idle", "forget")
    /\ UNCHANGED <<row, wokeAt, nextId, charged, snap>>

IdleForget == pc["idle"] = "forget" /\ Forget("idle", "done")

(***************************************************************************)
(* trash (sandbox-trash.ts trashSandbox): one transaction that deletes the *)
(* row (charging it), then the stop.                                       *)
(***************************************************************************)

TrashRead ==
    /\ pc["trash"] = "idle"
    /\ Goto("trash", IF row THEN "forget" ELSE "done")
    /\ UNCHANGED <<fly, row, wokeAt, nextId, charged, snap, destroyedRunning>>

TrashForget == pc["trash"] = "forget" /\ Forget("trash", "stop")

TrashStop ==
    /\ pc["trash"] = "stop"
    /\ fly' = IF fly = "running" THEN "stopped" ELSE fly
    /\ Goto("trash", "done")
    /\ UNCHANGED <<row, wokeAt, nextId, charged, snap, destroyedRunning>>

(***************************************************************************)
(* The machine on its own: the daemon exits on idle (and the meter's       *)
(* over-budget stop looks the same), and Fly can lose it. Fly autostart is *)
(* off (sandbox-run fly.ts), so only a wake starts it.                     *)
(***************************************************************************)

SelfStop ==
    /\ fly = "running"
    /\ fly' = "stopped"
    /\ UNCHANGED <<row, wokeAt, nextId, charged, pc, snap, destroyedRunning>>

Vanish ==
    /\ fly # "gone"
    /\ fly' = "gone"
    /\ UNCHANGED <<row, wokeAt, nextId, charged, pc, snap, destroyedRunning>>

Next ==
    \/ \E w \in Wakes :
          \/ WakeRead(w) \/ WakeSettle(w) \/ WakeClose(w) \/ WakeStart(w)
          \/ WakeForget(w) \/ WakeOpen(w) \/ WakeUndo(w)
    \/ MeterRead \/ MeterSettle \/ MeterClose
    \/ AbuseRead \/ AbuseStop \/ AbuseClose
    \/ IdleRead \/ IdleSettle \/ IdleDestroy \/ IdleForget
    \/ TrashRead \/ TrashForget \/ TrashStop
    \/ SelfStop \/ Vanish

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* State-space reductions for TLC; neither changes which states violate a  *)
(* property.                                                               *)
(***************************************************************************)

\* Wake requests are interchangeable: every property is about the machine, never a request.
WakeSymmetry == Permutations(Wakes)

\* From these steps on, a process never reads its snapshot again before taking a new one.
Spent == {"idle", "done", "start", "open", "undo", "forget"}
View == <<fly, row, wokeAt, nextId, charged, pc, destroyedRunning,
          [p \in Procs |-> IF pc[p] \in Spent THEN None ELSE snap[p]]>>

(***************************************************************************)
(* Properties.                                                             *)
(***************************************************************************)

\* No stretch reaches hostedUsage twice.
NoDoubleCharge == \A s \in Stretches : charged[s] <= 1

\* Every stretch ever opened is either still open on the row or charged.
NoLostStretch == \A s \in Stretches : s < nextId => (charged[s] >= 1 \/ (row /\ wokeAt = s))

\* With nothing mid-flight, a running machine has a row holding an open stretch.
Quiescent == \A p \in Procs : pc[p] \in {"idle", "done"}
RunningIsMetered == (Quiescent /\ fly = "running") => (row /\ wokeAt # None)

\* The idle sweep never destroys a machine somebody has woken. Known not to hold: README.md.
NoDestroyWhileRunning == ~destroyedRunning
=============================================================================
