# The hosted machine ladder, and moving a sandbox between rungs

Three sizes of hosted machine instead of one, and a tested way to move a sandbox from any of them to any other.
Written 2026-09-20. Supersedes the one-shape model in [pricing-model.md](pricing-model.md) §5; that note's argument
for selling a machine rather than a credit economy stands, and its §2 cost table is recomputed here.

## 1. What was wrong

Paying changed hours and reclamation, never the machine. Free and paid were the same `shared-cpu-4x` · 4 GB · 10 GB
box, and the pricing page said so in as many words. Three things followed:

- **4 GB is the floor, not a working size.** A sandbox runs a privileged nested `dockerd`, `cloudflared`, the
  daemon, an agent CLI and whatever dev server the work needs. A TypeScript language server alone takes 1–2 GB. An
  OOM during a build reads to the person it happens to as "intentic is broken".
- **Nothing recorded what a machine was.** The shape was read out of `config.hosted` at provision time and never
  written down, so the Billing page reported the config's *current* values as if they were your machine's. With one
  shape that was merely fragile; with three it is a lie.
- **Nothing could change a machine.** No volume `extend`, no snapshot, no fork in the Fly client. A sandbox that
  needed a bigger box, a different region, or a host that had not failed had no path to one.

## 2. The ladder

Fly's published `iad` rates: RAM is $5.19/GB-month, volumes $0.15/GB-month, snapshots $0.08/GB-month of
*incremental stored* data with the first 10 GB free. Every figure below is derived from
[`@intentic/constants` hosted-tiers](../../_tools/constants/src/hosted-tiers.ts), which is the only place they live.

| Rung | Guest | Disk | $/awake-h | Disk/mo | Price | Awake hours |
| --- | --- | --- | --- | --- | --- | --- |
| **Free** | `shared-cpu-4x` · 4 GB | 10 GB | $0.0329 | $1.50 | $0 | 40/mo (10 in the first week) |
| **Standard** | `shared-cpu-8x` · 8 GB | 25 GB | $0.0657 | $3.75 | $20 | 220/mo |
| **Max** | `shared-cpu-8x` · 16 GB | 50 GB | $0.1234 | $7.50 | $50 | 320/mo |

Two facts decided the shapes, and both are worth keeping in mind before moving one.

**Extra shared vCPUs are nearly free once you are paying for RAM.** `shared-cpu-8x` costs $8.07/month more than
`4x`; the step from 4 GB to 8 GB costs $41.52. So both paid rungs go wide on CPU — it is rounding error — and are
careful with memory and disk, which are not. Note that `4x` and `8x` share a volume ceiling (8000 IOPs, 32 MiB/s),
so the cores buy parallelism, not disk throughput.

**The free rung's cost is its disk, not its CPU.** Forty awake hours at `4x`/4 GB is $1.32; its 10 GB volume is
$1.50 a month standing, whether or not the person comes back. Dropping free to `shared-cpu-2x` would save $0.66 a
month and halve the volume's ceiling to 4000 IOPs and 16 MiB/s — which is exactly what a dependency install and an
image pull wait on. The free rung's shape is unchanged from before the ladder.

### Why each paid rung has an hour ceiling

Because the arithmetic does not work without one. At $20, net of Stripe's 2.9% + 30¢, Standard has $15.37 of compute
to give after its disk; at $0.0657 an awake hour that is 234 hours. An always-on Standard machine costs $51 a month.
The ceiling is set below break-even for every rung, and `hosted-tiers.test.ts` refuses a ladder where it is not:

> for every paid rung, `monthlyHours × flyHourUsd + volumeGb × 0.15` must be at most `priceUsd × 0.971 − 0.30`

That is a property of the table, checked by shape rather than by a list of rung names, so a fourth rung is held to it
without the test being touched. The free rung is exempt and has a ceiling of its own
(`FREE_TIER_MONTHLY_CEILING_USD`), because its worst month is an acquisition price rather than a loss.

Expected use sits far below the caps: a heavy member in the earlier note's table is 90 awake hours. At 150 hours a
Standard machine costs $13.61 and earns $19.12. The cap exists to bound the always-on tail, not to meter work.

### What money does not change

No feature, capability, extension, automation or shared workspace is behind a rung. The positioning line survives
with one word added: **money changes whose machine and how big, never what an agent can do.** The pricing page's "no
tiers" claim becomes "no *feature* tiers", which is the thing it was always defending.

## 3. Slots and machines are separate

A plan sells **slots at a rung** (`HostedPlanItem`: one Stripe subscription item per rung, quantity = slots).
Which machine stands on which slot is a second, separate act (`hostedPlan.changeTier`).

This is the one design decision worth arguing for. The obvious alternative — checkout hands you a Standard machine —
puts a Stripe write and a machine migration in one transaction that has no transaction. Whichever order you pick,
one failure mode is a charge with nothing behind it or a machine nobody paid for, and the remedy is compensating
logic that has to be right on a path nobody exercises.

Separating them removes the question. A migration that rolls back leaves a **paid-for empty slot**, which is a state
the Billing page can show and the owner can act on. Cancelling a slot under a standing machine is refused by a count,
not by a rollback. Neither act needs to know the other happened.

It also makes the product simpler: **everybody starts on a free machine and moves up.** Provisioning only ever hands
out the free rung, which keeps the instant-start promise and the warm pool honest (stock is free-shaped, so a claim
never hands over a machine that is not what it was sold as).

## 4. Two operations, one safety rule

[hosted-migrate.ts](../../_platform/api/src/sandbox/hosted/hosted-migrate.ts). The kind is decided by whether the
region changes.

**`resize`** — same app, same volume, same host. Snapshot the disk, grow it if the target rung has more, replace the
machine's guest, start, wait for the daemon to announce, then write the new shape onto the row. Seconds; nothing is
copied. A failure after the guest was replaced puts the old guest back.

**`move`** — a region change, a host with no room for the bigger guest, a failing host. Snapshot, stop the machine,
build a new volume (a block-level fork in the same region, a snapshot restore across regions), create a new machine
on it, wait for the announce, swap the row, **then** destroy the old pair. The Fly *app* never changes, so the
hostname, the connect token, the edge's replay and the app name are all untouched: from outside, the sandbox has not
moved.

> **The old disk is destroyed only after the new machine has announced itself on the new one.** Every step above is
> arranged around that sentence. Before the swap, any failure destroys what the run built and starts the original
> back up; the pre-flight snapshot outlives even that, so the disk as it was is recoverable after the machine has
> already been put back.

Three smaller rules fall out of the provider's own limits:

- **A downgrade never shrinks the disk.** Fly volumes grow and never shrink, and a snapshot restores only into an
  equal-or-larger volume, so the only way down is a file-level copy. Keeping the bigger disk costs at most $3.75 a
  month and removes the entire class of failure. `planMigration` takes the larger of the two disks, always.
- **Volumes are created with a `compute` placement hint.** A volume placed without one can land on a host with room
  for the volume and not for the machine it is for — which turns a resize into a move at the worst moment.
- **`rolledBack` and `failed` are different.** `rolledBack` means something was changed and put back. `failed` means
  nothing was changed at all, which is what a run that dies while still taking its snapshot deserves: restarting the
  machine to "put it back" would be the only harm done.

### What the daemon's announce proves

Verification waits for `Sandbox.lastSeenAt` to move past a mark taken before the restart. That one signal proves both
halves at once: the machine booted, **and** the volume it booted onto is the workspace — the daemon reads it before
it announces. It also needs no reachability assumption about the platform's own egress, unlike probing the front door.

### When a run dies

A migration holds `HostedMachine.migratingId` (the same shape `buildingId` already uses) and may be paying for a
half-built second machine inside a live app, which the orphan reaper will never touch because the app is somebody's.
`sweepHostedMigrations` rides the hourly meter tick, frees the lock past a deadline, and destroys whatever the dead
run built. It never tries to finish the work: it cannot know where the run got to.

## 5. Backups

Fly takes daily block-level snapshots of every volume. Retention was previously whatever Fly defaulted to; it is now
stated (`hosted.snapshotRetentionDays`, 7) and passed at volume create, because a backup window nobody wrote down is
one nobody can promise. Every migration takes an on-demand snapshot first and records its id on the row, so a
recovery point exists for the exact moment before the change. `lastHostedBackupAt` reads the newest finished one.

Cost: $0.08/GB-month of *changed* data, first 10 GB a month free. On a 25 GB volume with a few GB of churn this is
cents.

## 6. Where the figures live

One module, `@intentic/constants` hosted-tiers, imported by the platform's config defaults, the site's pricing copy,
the Billing page and the tests. Before this, `_site/site-content/src/hosted.ts` hand-mirrored the config's defaults
with a comment admitting it; three rungs would have tripled that. `config.hosted.{cpus,memoryMb,volumeGb,
monthlyHours}` are now the free rung's fields and remain an operator's to override, because a self-hosted platform
runs its own hardware; a paid rung's shape is the ladder's and not a deployment's to change.

## 7. What each row now records

- `HostedMachine` carries `tier` **and** the four shape numbers. Both, because they diverge: mid-migration the
  machine is still the old shape while the rung is already the new one, and editing the ladder changes what a rung
  means without touching a single machine. Every surface that tells somebody what their machine is reads the row.
- `HostedUsage` is keyed by sandbox (the ceiling is the machine's rung's) and **also** carries the owner, whose
  column outlives the sandbox (`onDelete: SetNull`). Without that, releasing a spent free machine and asking for
  another would reset the month — the whole free lane for the price of clicking twice. The account's sum is what the
  provision gate reads; a machine's own row is what its wake is judged against.
- `SandboxTrash` carries the rung and shape too: the disk held back from teardown is a particular size, and a restore
  has to put the machine back as it was rather than as a new one would be.
- `HostedMigration` records the shape either side as numbers rather than rung names, so a later edit to the ladder
  cannot rewrite the history of what a machine was.

## 8. What this changed elsewhere

- **The abuse watch** divided by `config.hosted.cpus` inside a fleet-wide Prometheus query. With one CPU count that
  was fine; with three, a Max machine doing ordinary work would have read as twice as busy as it was and been stopped
  at half load. The query no longer divides, and each verdict is normalised by the machine's own CPUs.
- **The hour meter's stop** is judged per machine rather than per account, so an account holding a spent free machine
  and a Standard one nowhere near its hours loses only the first.
- **The offer card** states the free lane's hours to subscribers too, because the machine it offers is a free one.

## 9. Not decided here

- Whether the prices are right in a year. The admin panel's cost-by-rung is what answers that; the ladder module is
  what makes either number legible.
- A dedicated-CPU rung. `performance-2x` doubles the volume's IOPs ceiling (16000 against 8000) and would be a real
  differentiator for install-heavy work, at roughly $99 a month. It is a fourth row in the table and one Stripe
  price; the invariant test will judge it.
- Watching the sandbox machine for OOM. Fly reports `oom_killed` on a machine's exit event and `getMachineDetail`
  already reads it, but only the overlay builder looks. It is first a reliability signal and second the only honest
  upgrade prompt there is: "this machine ran out of memory twice this week" is a fact, not a pitch.
