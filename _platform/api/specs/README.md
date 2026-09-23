# specs

TLA+ models of platform code where interleavings, not inputs, decide whether the code is right. TLC checks each
one exhaustively over a small bounded state space.

## HostedStretch

This models the awake-hour meter of one hosted machine: the Fly machine, its `HostedMachine` row, the row's
`wokeAt` column, and every path that opens or closes the stretch that column holds. A stretch is an id, not a
duration, so the properties are about which stretches reach `hostedUsage` and how many times.

| model process | code                                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| `wake`        | `sandbox.routes.ts` `wake`: `settleHostedStretch`, `wakeHosted`, then `openStretchOrStop`                |
| `meter`       | `hosted-meter.ts` tick, `settleHostedStretches` (one pass at a time, `JOB_HOSTED_METER`)                  |
| `abuse`       | `hosted-abuse.ts`: `stopMachine`, then `closeHostedStretch(…, now)`                                       |
| `idle`        | `hosted-idle.ts` `decideIdleMachine`: forget a machine Fly lost; destroy a collected one, then forget it |
| `trash`       | `sandbox-trash.ts` `trashSandbox`: one transaction that deletes the row, then the stop                   |
| `SelfStop`    | the daemon exiting on idle, and the meter's over-budget stop                                              |
| `Vanish`      | Fly losing the machine                                                                                    |

The shared steps are the three stretch writes in `hosted-usage.ts`. Each one runs in a single transaction that holds
the row lock (`SELECT … FOR UPDATE`), so each is one atomic action in the model:

- `Close` is `closeHostedStretch`. It closes and charges the stretch the caller read, and does nothing if the row
  has moved on since.
- `WakeOpen` is `openHostedStretch`. It charges whatever stretch the row still holds, then opens the next. When
  the row is gone it reports that instead, and `openStretchOrStop` stops the machine it just started
  (`WakeUndo`).
- `Forget` is `dropHostedMachine`, which every row delete goes through (`forgetHostedMachine`, trash, release,
  the restart rebuild). It charges whatever stretch the row holds at that moment.

### Properties

- `NoLostStretch`: every stretch ever opened is either still open on the row or charged.
- `NoDoubleCharge`: no stretch is charged twice.
- `RunningIsMetered`: once nothing is in flight, a running machine has a row that holds an open stretch.
- `NoDestroyWhileRunning`: the idle sweep never destroys a machine that somebody has woken.

`HostedStretch.cfg` checks the first three with three concurrent wakes: 644,276 distinct states at depth 26, in
about 3 seconds on 12 workers. To confirm the properties still catch something, remove the charge from `WakeOpen`:
`NoLostStretch` then fails, because a wake on a running machine drops the stretch it was in.

### Known gap: `NoDestroyWhileRunning` fails

The idle sweep reads the machine as stopped, a wake starts it, and the sweep destroys the app under a wake that
just succeeded. Billing stays correct, because the forget that follows charges the wake's stretch, but the owner
loses a machine they had just opened. Closing it needs one per-sandbox lock that `wake` and the idle collect both
hold across their Fly calls. The configuration leaves this property out until that exists.

### What the model leaves out

- Minutes. Charging a zero-minute stretch counts as a charge, and month attribution is not modelled. A stretch
  that the wake's settle could not close (Fly unreachable) is charged up to the next open, which over-bills the
  stopped gap rather than losing the stretch.
- The restart route (a stop followed by the same steps as a wake), `releaseHosted` (a row delete like trash's,
  without a stop), and the warm-pool claim, which opens its stretch in the row's `create`.
- Migrations (`migrate/hosted-migrate.ts`). They start the machine without opening a stretch, so a migration that
  boots a stopped machine leaves it running unmetered until it stops itself.
- Budget and standing checks, which only refuse a wake before anything is written.
- More than one machine. Every path touches a single row, so machines do not interact.

The configuration uses `WakeSymmetry`, because wake requests are interchangeable. It also uses `View`, which drops a
process's snapshot once no later step of that process reads it. Neither reduction changes which states violate a
property.

## Running

TLC needs Java 11 or newer and `tla2tools.jar` from the
[TLA+ releases](https://github.com/tlaplus/tlaplus/releases). The model checker writes its working
state to `-metadir`, so the repository stays clean:

```bash
java -cp tla2tools.jar tlc2.TLC -config HostedStretch.cfg -metadir /tmp/tlc -noGenerateSpecTE -workers auto HostedStretch.tla
```

When a file in the table above changes how it reads or writes `wokeAt`, change its action in `HostedStretch.tla`
in the same commit and run the check again.
