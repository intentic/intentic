# specs

TLA+ models of platform code where interleavings, not inputs, decide whether the code is right. TLC checks each
one exhaustively over a small bounded state space.

## HostedStretch

This models the awake-hour meter of one hosted machine: the Fly machine, its `HostedMachine` row, the row's
`wokeAt` column, and every path that opens or closes the stretch that column holds. A stretch is an id, not a
duration, so the properties are about which stretches reach `hostedUsage` and how many times.

| model process | code                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `wake`        | `sandbox.routes.ts` `wake`: `settleHostedStretch`, `wakeHosted`, `openHostedStretch`                  |
| `meter`       | `hosted-meter.ts` tick, `settleHostedStretches` (one pass at a time, `JOB_HOSTED_METER`)                |
| `abuse`       | `hosted-abuse.ts`: `stopMachine`, then `closeHostedStretch(…, now)`                                     |
| `idle`        | `hosted-idle.ts` `decideIdleMachine`: the gone branch and the collect branch                           |
| `trash`       | `sandbox-trash.ts` `trashSandbox`: stop, then one transaction closing and deleting                      |
| `SelfStop`    | the daemon exiting on idle, and the meter's over-budget stop                                            |
| `Vanish`      | Fly losing the machine                                                                                  |

The shared steps are `closeHostedStretch` (`Close`, `Clear`), `openHostedStretch` (`WakeOpen`) and
`forgetHostedMachine` or the cascade delete (`Forget`). Each wake request is a separate process, and the
configurations run two or three at once.

### Properties

- `NoLostStretch`: every stretch ever opened is either still open on the row or charged.
- `NoDoubleCharge`: no stretch is charged twice.
- `RunningIsMetered`: once nothing is in flight, a running machine has a row that holds an open stretch.
- `NoDestroyWhileRunning`: the idle sweep never destroys a machine that somebody has woken.

### What the code as built does

`HostedStretch.cfg` fails. Checked one property at a time, each yields a short counterexample:

1. **NoLostStretch, one request.** The machine is running with stretch 1 open. A browser that lost its
   connection calls `wake`. `settleHostedStretch` sees a live machine and leaves stretch 1 open.
   `wakeHosted` succeeds because the machine is already live. `openHostedStretch` then writes a new
   `wokeAt`, and every minute of stretch 1 is never charged. The editor fires this on every `network`,
   `timeout` or `closed` failure (`useSandbox.ts`, throttled per browser), so a running machine with a
   flaky connection is under-billed each time.
2. **NoDoubleCharge, abuse against wake.** Abuse reads stretch 1 and stops the machine. A wake reads
   stretch 1, sees it stopped, charges it and clears it. Abuse then charges its own copy of stretch 1 a
   second time. `closeHostedStretch` charges whatever stretch it was handed and never checks that the
   column still holds it. The meter's settle racing a wake gives the same double charge and then nulls
   the stretch the wake just opened.
3. **RunningIsMetered, trash against wake.** A wake reads the row. Trash stops the machine. The wake starts
   it again and opens stretch 2. Trash commits, and its transaction deletes the row. The machine is left
   running with no row, which the meter and the idle sweep cannot see, and nothing bills it.
4. **NoDestroyWhileRunning, idle collect against wake.** The idle sweep reads the machine as stopped. A
   wake starts it. The sweep closes the stretch and destroys the app under the wake that just succeeded.

### The fix `Fixed = TRUE` models

`HostedStretchFixed.cfg` passes `TypeOK`, `NoLostStretch`, `NoDoubleCharge` and `RunningIsMetered` with three
concurrent wakes: 1,205,657 distinct states at depth 27, in about 15 seconds on 12 workers. Each point below is
one change in the code:

1. **Close by compare-and-set.** `closeHostedStretch` runs one transaction: clear `wokeAt` only where it still
   equals the value read, and charge only when that update matched a row.
2. **Open by rotating.** `openHostedStretch` runs one transaction that reads `wokeAt` `FOR UPDATE`, charges
   the stretch it held (to now), and writes the new one. A wake on a live machine then closes the old
   stretch instead of dropping it.
3. **Delete charges.** Every row delete (`forgetHostedMachine`, the idle sweep, trash) is
   `DELETE … RETURNING "wokeAt"` with the charge in the same transaction, so the delete closes whatever the
   row holds at that moment, not a copy read earlier.
4. **Wake undoes an unbillable start.** When `openHostedStretch` finds no row, the wake stops the machine it
   just started.
5. **Delete, then stop.** Trash deletes the row first and stops the machine after. The idle sweep deletes the
   row before it destroys the app.

The fix does not repair `NoDestroyWhileRunning`, so the fixed configuration leaves it out. Closing that gap
needs one per-sandbox lock held by both `wake` and the idle collect, across the Fly calls.

After changes 2 and 3, a stretch that `settleHostedStretch` could not close (Fly unreachable) is charged up to
the next wake. That over-bills the stopped gap instead of losing the stretch. No property here covers
durations.

### What the model leaves out

- Minutes. Charging a zero-minute stretch counts as a charge, and month attribution is not modelled.
- The restart route (a stop followed by the same steps as a wake), `releaseHosted`, the rebuild branch of
  `restartOrRebuild`, and the warm-pool claim, which opens its stretch in the row's `create`.
- Budget and standing checks, which only refuse a wake before anything is written.
- More than one machine. Every path touches a single row, so machines do not interact.

Both configurations use `WakeSymmetry`, because wake requests are interchangeable. They also use `View`, which
drops a process's snapshot once no later step of that process reads it. Neither reduction changes which states
violate a property. With both removed, the three-wake run had written 2.4 GB of TLC state after 17 CPU-minutes and had not
finished.

## Running

TLC needs Java 11 or newer and `tla2tools.jar` from the
[TLA+ releases](https://github.com/tlaplus/tlaplus/releases). The model checker writes its working
state to `-metadir`, so the repository stays clean:

```bash
java -cp tla2tools.jar tlc2.TLC -config HostedStretch.cfg      -metadir /tmp/tlc -noGenerateSpecTE -workers auto HostedStretch.tla
java -cp tla2tools.jar tlc2.TLC -config HostedStretchFixed.cfg -metadir /tmp/tlc -noGenerateSpecTE -workers auto HostedStretch.tla
```

The first run stops at the first violated invariant, which is the shortest counterexample. To see the
others, list one invariant per run. When a file in the table above changes how it reads or writes
`wokeAt`, change its action in `HostedStretch.tla` in the same commit.
