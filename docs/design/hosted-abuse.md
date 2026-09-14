# The free lane's abuse defences

What somebody who wants free compute sees when they look at intentic, and what the platform does about it.
Written 2026-09-14 from the source as it stands; every figure below is a `config.ts` default, named so it can
be checked rather than trusted. Companion to [pricing-model.md](pricing-model.md) (what the free lane is) and
the Acceptable Use Policy in `_site/site-content/src/legal.ts` (what it is for).

## 1. What the free lane looks like from outside

One Google sign-in buys one Fly machine: 4 shared vCPUs, 4 GB, 10 GB of disk, root, on the public internet,
awake 40 hours a month, asleep 20 minutes after the last sign of life, collected after three weeks unopened.
Awake time is metered per owner and enforced at wake, with an hourly tick that stops a machine an hour past
its month. That is the whole of what stood between the lane and its two obvious abusers.

**The miner.** Keeps the machine awake (an open tab, a terminal printing hashrate, an armed watch) and runs it
flat out for the 41 hours the meter allows. The money is small: an awake hour costs $0.032, so a saturated
month is $1.28 plus $1.50 of disk. The risk is not the bill. Fly forbids mining, its abuse detection watches
CPU shapes, and a handful of miners on the org is how the whole platform's provider account gets suspended.

**The farm.** One Google account is one machine; a hundred Google accounts are a hundred machines, a hundred
disks, and a hundred slots of a fleet ceiling and a warm pool that were sized for people. A Workspace domain
mints its users by the hundred in an afternoon. Nothing looked at account age, source address or domain.

**What the platform cannot do about either.** It cannot look inside a machine. The terms promise that ("we
cannot read what is on it, and we will not build ourselves a way to"), the DPA repeats it, and it is true by
construction: the daemon is root to the owner, and any figure it reported about itself would be the owner's to
fake. So every defence below is built from what the platform already holds — the account, the request, the
row — and from the one party that meters the machine from outside: the provider.

## 2. The mechanisms

Four, each a knob in `config.ts`'s `hosted` block with 0 as off, each passed through the self-host compose
file, each with a plain sentence for the person it refuses.

### Standing

`User.hostedSuspendedAt` + `hostedSuspendedReason` ([hosted-standing.ts](../../_platform/api/src/sandbox/hosted/abuse/hosted-standing.ts)).
Suspended, nothing hosted starts for the account: provision, wake, restart and rebuild answer FORBIDDEN with
the reason and the legal contact, the offer reads `suspended` so the setup page never draws the button, and the
hourly meter tick stops anything still awake. The account itself, its sandboxes on the owner's own computers
and every file are untouched; the suspension is of the machine we pay for, nothing else. Written by an
operator from the admin panel (`admin.userSuspend`, the account's email retyped, a reason that is shown to the
owner every time they are refused) or by the abuse watch's second strike; lifted only by an operator
(`admin.userUnsuspend`). The editor's connecting gate says what is off, that the files remain, and offers the
owner's own computer; a guest is told it is the owner's account.

### The newcomer ramp

`newAccountDays` 7, `newAccountHours` 10 ([hosted-usage.ts](../../_platform/api/src/sandbox/hosted/hosted-usage.ts)).
An account younger than a week has 10 awake hours as its month's ceiling instead of 40. Plenty to evaluate
the product (a first session is an hour or two, and the machine sleeps twenty minutes after the last sign of
life); a quarter of the payoff for a throwaway account, and the only defence that costs a farm the one thing
it cannot script, time. The budget answers `rampUntil`, so the Billing page, the offer and the setup rung all
say when the full month applies, and the pricing page carries the figure in the same sentence as the forty.

### The same-source caps

`provisionsPerIpPerDay` 3, `provisionsPerDomainPerDay` 10 ([hosted-source.ts](../../_platform/api/src/sandbox/hosted/abuse/hosted-source.ts)).
Every successful provision writes a `HostedProvision` row: the account, the client address, the email domain,
the app. A new machine is refused (TOO_MANY_REQUESTS, pointing at the own-computer lane) when three *other*
accounts were handed one from the same address in the last day, or ten from the same email domain. The domain
cap skips gmail and googlemail, which are nobody's organisation; the address cap skips itself when there is no
address to read. An account's own earlier machines never count against it — release-and-provision on one
account is the slot gate's business. Rows are personal data and are dropped after thirty days.

The address is read from **one** header, `api.trustedIpHeader` (`cf-connecting-ip`; the platform runs behind
cloudflared), and Better Auth is pointed at the same header for the address a session records. Before this,
sessions trusted `x-forwarded-for` first, which a caller can write.

### The abuse watch

`abuseMinutes` 15, `abuseWindowMinutes` 90, `abuseCpuShare` 0.85, `abuseEgressGbPerHour` 10,
`abuseStrikesToSuspend` 2, `abuseStrikeDays` 30 ([hosted-abuse.ts](../../_platform/api/src/sandbox/hosted/abuse/hosted-abuse.ts),
[fly-metrics.ts](../../_platform/api/src/sandbox/hosted/fly/fly-metrics.ts)).

Fly's managed Prometheus exposes every machine's CPU time by mode and bytes sent, from the hypervisor, read
with the same org token the Machines API uses. Every quarter hour the watch asks two questions of the whole
fleet at once — busy share of the machine's CPUs and GB sent per hour, each averaged over the window — and
judges every machine whose current awake stretch is at least a window long, matched on app *and* machine id
so an overlay builder in the same app is never mistaken for the sandbox. Development work is bursty: a build
that pins four cores for ten minutes averages far under 85% over ninety. A miner is flat out for as long as the
machine is awake.

A free machine over the line is stopped, its stretch settled and charged, a `HostedStrike` written, and its
owner emailed: what was measured, that reopening the sandbox is fine if it was real work, that a repeat within
thirty days switches hosted sandboxes off. The second strike within thirty days does exactly that, and the
email says so. A subscriber's machine is never stopped by the watch, only reported: a long job on a machine
somebody pays for is theirs to run, and an operator reads the report. One strike per machine per window; a
reopened machine earns a fresh one. Strikes keep the ledger window (thirteen months), the same as the hours
they are argued against.

## 3. Where an operator sees it

The attention feed (and its daily digest) lists every strike of the last week — a stop is worth a look, a
suspension or a subscriber's report needs a person — and every suspended account. The account page shows the
standing with its reason, the strikes in the page's own units, and the two buttons. The directory marks a
suspended account beside the plan chip. The GDPR export carries the subject's provision rows, strikes and
standing, since all three are about them.

## 4. Considered and not done

- **Anything inside the box.** A daemon-reported load figure, a process list, a cgroup quota on agent
  processes: each breaks the promise the terms make, and each is root's to defeat in a line. The hypervisor's
  meter is the honest signal and the provider's own.
- **A stricter idle-stop.** Ignoring terminal output when nobody is connected would put a miner to sleep in
  twenty minutes, and a legitimate long build with it. The meter bounds what an awake machine can cost; the
  watch bounds what it can be used for.
- **A card, a phone number, a CAPTCHA at sign-in.** The free lane's promise is no card; Google already gates
  account creation harder than a CAPTCHA would; a phone number is a data-protection commitment for a
  marginal gain.
- **A platform-wide provisions-per-day brake.** A launch day and a farm look the same from that number. The
  fleet ceiling (`maxMachines`) already caps the damage, and the caps above are what tell the two apart.
- **The trial meter.** Twelve free-tier Gemini messages per account per day are not worth a mechanism yet;
  the same-source rows would serve one if they ever are.

## 5. What to watch after it ships

The false-positive rate of the watch, read off the strikes with `action: stopped` whose owner opened the
sandbox again within the hour, and how many same-source refusals real people meet (the log line
`hosted provision: refused by a same-source cap`). Both thresholds are knobs for exactly this reason. If the
ramp costs sign-ups, `newAccountHours` is the number to move, and the pricing page moves with it.
