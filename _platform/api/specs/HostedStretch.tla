--------------------------- MODULE HostedStretch ---------------------------
(***************************************************************************)
(* The awake-hour meter of ONE hosted machine: its Fly state, its          *)
(* HostedMachine row, the row's `wokeAt` column, and every path that       *)
(* opens or closes the stretch that column holds (hosted-usage.ts and its  *)
(* callers). A stretch is an id, not a duration: the properties are about  *)
(* which stretches reach hostedUsage, and how many times.                  *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
    Wakes,  \* concurrent `wake` requests, each one-shot
    Fixed   \* FALSE models the code as built, TRUE the fix in README.md

ASSUME Fixed \in BOOLEAN

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

\* closeHostedStretch(snap). As built: chargeMinutes, then a separate unconditional
\* `wokeAt: null`. Fixed: one transaction that closes only the stretch it read.
Close(p, clearAt, next) ==
    /\ IF Fixed
          THEN /\ IF row /\ snap[p] # None /\ wokeAt = snap[p]
                     THEN wokeAt' = None /\ charged' = Charge(snap[p])
                     ELSE UNCHANGED <<wokeAt, charged>>
               /\ Goto(p, next)
          ELSE /\ charged' = Charge(snap[p])
               /\ UNCHANGED wokeAt
               /\ Goto(p, clearAt)
    /\ UNCHANGED <<fly, row, nextId, snap, destroyedRunning>>

\* The as-built second half of Close; Prisma's update throws on a deleted row.
Clear(p, next, failed) ==
    /\ IF row THEN wokeAt' = None /\ Goto(p, next) ELSE UNCHANGED wokeAt /\ Goto(p, failed)
    /\ UNCHANGED <<fly, row, nextId, charged, snap, destroyedRunning>>

\* Deleting the row. Fixed: DELETE ... RETURNING wokeAt, charged in the same transaction.
Forget(p, next) ==
    /\ row' = FALSE
    /\ wokeAt' = None
    /\ charged' = IF Fixed /\ row THEN Charge(wokeAt) ELSE charged
    /\ Goto(p, next)
    /\ UNCHANGED <<fly, nextId, snap, destroyedRunning>>

(***************************************************************************)
(* wake (sandbox.routes.ts): read the row, settleHostedStretch, wakeHosted,*)
(* openHostedStretch. Any browser that loses the daemon calls it.          *)
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

WakeClose(w) == pc[w] = "close" /\ Close(w, "clear", "start")
WakeClear(w) == pc[w] = "clear" /\ Clear(w, "start", "done")

\* A refused start on a live machine reads as success, so only a stopped one can fail.
WakeStart(w) ==
    /\ pc[w] = "start"
    /\ \/ fly = "gone" /\ UNCHANGED fly /\ Goto(w, "forget")
       \/ fly # "gone" /\ fly' = "running" /\ Goto(w, "open")
       \/ fly = "stopped" /\ UNCHANGED fly /\ Goto(w, "done")
    /\ UNCHANGED <<row, wokeAt, nextId, charged, snap, destroyedRunning>>

WakeForget(w) == pc[w] = "forget" /\ Forget(w, "done")

\* As built: overwrite the column. Fixed: charge whatever it held in the same transaction;
\* with no row left, stop the machine this wake just started.
WakeOpen(w) ==
    /\ pc[w] = "open"
    /\ IF row
          THEN /\ wokeAt' = nextId
               /\ nextId' = nextId + 1
               /\ charged' = IF Fixed THEN Charge(wokeAt) ELSE charged
               /\ Goto(w, "done")
          ELSE /\ UNCHANGED <<wokeAt, nextId, charged>>
               /\ Goto(w, IF Fixed THEN "undo" ELSE "done")
    /\ UNCHANGED <<fly, row, snap, destroyedRunning>>

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

MeterClose == pc["meter"] = "close" /\ Close("meter", "clear", "idle")
MeterClear == pc["meter"] = "clear" /\ Clear("meter", "idle", "idle")

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

AbuseClose == pc["abuse"] = "close" /\ Close("abuse", "clear", "done")
AbuseClear == pc["abuse"] = "clear" /\ Clear("abuse", "done", "done")

(***************************************************************************)
(* idle (hosted-idle.ts decideIdleMachine): drop a machine Fly lost,       *)
(* collect one stopped past its deadline. As built: close, destroy, forget.*)
(* Fixed: forget (which charges), then destroy.                            *)
(***************************************************************************)

IdleRead ==
    /\ pc["idle"] = "idle"
    /\ row
    /\ Keep("idle", wokeAt)
    /\ Goto("idle", "settle")
    /\ UNCHANGED <<fly, row, wokeAt, nextId, charged, destroyedRunning>>

\* Not due, still running, or getMachine failed: the machine is kept.
IdleSettle ==
    /\ pc["idle"] = "settle"
    /\ \/ Goto("idle", "done")
       \/ fly = "gone" /\ Goto("idle", IF Fixed THEN "goneForget" ELSE "goneClose")
       \/ fly = "stopped" /\ Goto("idle", IF Fixed THEN "collectForget" ELSE "collectClose")
    /\ UNCHANGED <<fly, row, wokeAt, nextId, charged, snap, destroyedRunning>>

IdleGoneClose == pc["idle"] = "goneClose" /\ Close("idle", "goneClear", "goneForget")
IdleGoneClear == pc["idle"] = "goneClear" /\ Clear("idle", "goneForget", "done")
IdleGoneForget == pc["idle"] = "goneForget" /\ Forget("idle", "done")

IdleCollectClose == pc["idle"] = "collectClose" /\ Close("idle", "collectClear", "destroy")
IdleCollectClear == pc["idle"] = "collectClear" /\ Clear("idle", "destroy", "done")
IdleCollectForget == pc["idle"] = "collectForget" /\ Forget("idle", IF Fixed THEN "destroy" ELSE "done")

IdleDestroy ==
    /\ pc["idle"] = "destroy"
    /\ fly' = "gone"
    /\ destroyedRunning' = (destroyedRunning \/ fly = "running")
    /\ Goto("idle", IF Fixed THEN "done" ELSE "collectForget")
    /\ UNCHANGED <<row, wokeAt, nextId, charged, snap>>

(***************************************************************************)
(* trash (sandbox-trash.ts trashSandbox). As built: stop, then one         *)
(* transaction closing the stretch read BEFORE it and deleting the row.    *)
(* Fixed: delete (which charges), then stop.                               *)
(***************************************************************************)

TrashRead ==
    /\ pc["trash"] = "idle"
    /\ IF row
          THEN Keep("trash", wokeAt) /\ Goto("trash", IF Fixed THEN "forget" ELSE "stop")
          ELSE UNCHANGED snap /\ Goto("trash", "done")
    /\ UNCHANGED <<fly, row, wokeAt, nextId, charged, destroyedRunning>>

TrashStop ==
    /\ pc["trash"] = "stop"
    /\ fly' = IF fly = "running" THEN "stopped" ELSE fly
    /\ Goto("trash", IF Fixed THEN "done" ELSE "commit")
    /\ UNCHANGED <<row, wokeAt, nextId, charged, snap, destroyedRunning>>

TrashCommit ==
    /\ pc["trash"] = "commit"
    /\ IF row
          THEN /\ charged' = Charge(snap["trash"])
               /\ row' = FALSE
               /\ wokeAt' = None
          ELSE UNCHANGED <<charged, row, wokeAt>>
    /\ Goto("trash", "done")
    /\ UNCHANGED <<fly, nextId, snap, destroyedRunning>>

TrashForget == pc["trash"] = "forget" /\ Forget("trash", "stop")

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
          \/ WakeRead(w) \/ WakeSettle(w) \/ WakeClose(w) \/ WakeClear(w)
          \/ WakeStart(w) \/ WakeForget(w) \/ WakeOpen(w) \/ WakeUndo(w)
    \/ MeterRead \/ MeterSettle \/ MeterClose \/ MeterClear
    \/ AbuseRead \/ AbuseStop \/ AbuseClose \/ AbuseClear
    \/ IdleRead \/ IdleSettle \/ IdleGoneClose \/ IdleGoneClear \/ IdleGoneForget
    \/ IdleCollectClose \/ IdleCollectClear \/ IdleCollectForget \/ IdleDestroy
    \/ TrashRead \/ TrashStop \/ TrashCommit \/ TrashForget
    \/ SelfStop \/ Vanish

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* State-space reductions for TLC; neither changes which states violate a  *)
(* property.                                                               *)
(***************************************************************************)

\* Wake requests are interchangeable: every property is about the machine, never a request.
WakeSymmetry == Permutations(Wakes)

\* From these steps on, a process never reads its snapshot again before taking a new one.
Spent == {"idle", "done", "clear", "goneClear", "collectClear", "start", "open", "undo",
          "forget", "goneForget", "collectForget", "destroy"}
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

\* The idle sweep never destroys a machine somebody has woken.
NoDestroyWhileRunning == ~destroyedRunning
=============================================================================
