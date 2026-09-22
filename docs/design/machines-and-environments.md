# One PC, several environments: Windows and WSL as one machine

Written 2026-09-15 from the source as it stands. The question asked: a Windows PC with a WSL distro connects to a
sandbox twice — once from Windows, once from inside the distro — and every screen and every turn treated the two as
separate machines. The answer, stated once here and argued below: **a machine is the physical computer, an
environment is one OS install on it with its own agent and its own door, both agents stay, and the join is the card
the door hangs off — hostname plus the fact that one side is WSL for the doors that have no card.** Companion to the
last two sections of
[capabilities.md](../architecture/capabilities.md).

## 1. One card is one computer; an environment is a connection of it

Two things are true at once, and the first draft of this design mistook one for the other.

**An agent per OS install is unavoidable.** Mutagen watching a folder in a distro's filesystem has to run inside that
distro (over `\\wsl.localhost` it is slow and blind to changes), and the Windows side can neither hold that folder nor
own the distro's login shell and PATH. So a distro keeps its own agent and its own durable enrollment.

**A capability per OS install was a mistake.** The owner connected a computer, not a shell. Two cards meant two acts
of connecting with different outcomes — a PC connected on its Windows side alone would print a command it could
perfectly well have run — and it made one side of a machine a second-class row that the other side's distro listing
then called "not connected".

So: the `host` capability is the machine, and each environment connects under a key of that card. The native
environment's key IS the card id (`rog`), by definition rather than as a fallback, and a sibling hangs off it
(`rog::wsl:archlinux`); `hostEntryOf` takes a connection back to the card whose switches admit it
([schemas/hosts.ts](../../_shared/sandbox-contract/src/schemas/hosts.ts), `PeerDoor.cardOf`). A machine with one OS
install is therefore addressed exactly as it always was, and `HostSummary.environments` — native first, each with its
own liveness, version and facts — is what a page draws a row per and what a command picks from.

The device list is built per CONNECTION rather than per card: `hostConnections` expands each summary's environments
into one entry each, so a distro is read through its own socket and its row carries its own `hostId`, version,
platform and facts. Anything else leaves the side named after the card as the machine's only door — which is what left
a distro's agent with no way to be updated from here while the Windows side beside it had a button, and the two drifted
versions apart. The fold (`machinesOf`) is what puts those rows back together on screen, and it reads the card off
each row's `hostId` to do it: one card is one computer, so two doors naming it are one machine whatever either has
said about itself. The hostname join below still runs beside it, for the rows that have no card at all.

Environments are listed from the enrollments as well as from the hub: hub liveness resets when the daemon restarts, so
a distro that has not dialled in since must still read as a sleeping side of its computer rather than vanish from it.

## 2. Why the card leads the join, and why hostname plus WSL is the rest of it

The card is evidence nothing can withhold or forget. A hostname is not: it comes from the facts an agent sent at
connect or from a report behind "Run commands", both of which live in the hub, and hub state resets when the daemon
restarts. So every side of a PC that has not dialled in since holds no hostname at all, and a fold that reads only
hostnames leaves each sleeping environment standing as a computer of its own — a fleet of two PCs drawn as five rows,
which is the regression this section is now written against. Where a card is present it also decides what the machine
is CALLED and how it is addressed (`?device=<card>`), so a machine keeps its name and its URL when a second
environment connects.

The hostname rule is what remains for a door with no card — a desktop-sync enrollment, or a distro connected as a card
of its own, which the Windows side's "connect this distro" link still mints. WSL hands a distro the Windows machine's
hostname, and that is the whole evidence: two rows with one hostname where
one of them says `wsl:<distro>` are one PC by construction. Two rows with one hostname where neither says so are two
machines that happen to be named alike (a laptop and the desktop that replaced it), and folding them would put one
machine's buttons on the other's row — the fault the fold existed to avoid.

The fact has to arrive at connect time. It used to ride only the machine's report, which is behind "Run commands"; a
card with that switch off could never say which environment it was, and the daemon's fold read that silence as
agreement. `DeviceFacts` carries `hostname` and `wsl` now, and an agent old enough to send
neither says nothing rather than something false.

## 2b. One install, and where sync lands

Installing on either side connects the whole computer: the daemon reads the rest off the side that connected
(`wslDistros` from Windows, "the Windows side" from a distro), mints a pairing per environment and runs the bootstrap
shim across with `run_command`'s `in`. Nothing is asked of the agent beyond the release that took that argument, and
the pairing stays a credential only the daemon mints.

File sync then needs no second decision: mutagen can only watch the filesystem that holds the folder, so the FOLDER
picks the environment. A `C:\…` path enrols the Windows side, a `/home/…` path the distro, and the daemon routes the
line accordingly — including the install one-liner, which is written in the dialect of the environment it lands in
rather than the door it was sent to. The same rule carries every switch over an existing pairing: pause, resume,
unpair and the mirroring toggle go where that pairing's folder is, because only that agent holds its session.

An environment with its own agent is talked to directly; crossing is the fallback for one that has none. That is one
hop fewer, its own login shell, and no `wsl.exe` session to be torn down under a detached build.

## 3. What each screen does with it

The board's unit is the machine: one card, the environments as lines with their own state (a live Windows side and a
stopped distro have no single word for themselves), the containers once. The page's unit is the machine too, with the
environments as rows because each has an agent to update, a door to reconnect and an enrollment to revoke, and one
sandbox list because one engine serves every door: container verbs go through the first open door, folder verbs
through the environment whose report carries the pairing, and a command written for a path — the dev rebuild and the
dev reload, `sh` lines that `cd` into the checkout — through the environment that holds that path (`hostHoldingPath`),
reached directly where its own card is connected and by crossing from the Windows side where it is not. The first
open door is as often the Windows one, which answers a `sh` line with a parse error.

Each environment's row carries its own agent's **Restart**, because each side runs its own process. **Update** is the
machine's, drawn once over its environments: an update moves every side to one release (§3b), so a button per side
would promise something no side can do alone. It goes through the Windows door when that side can hear it and through
a distro otherwise, and its log lands under the row it went through. A machine whose sides report different builds
says so once, over the rows, with each side's build.

The Windows side's distro listing is what makes the second
environment discoverable from the first: a distro not yet connected is a Connect link into the Linux card's add form,
named `<pc>-wsl-<distro>` so the two ids read as one PC everywhere, and that name is what flips the Linux connect
dialog to its PowerShell form.

## 3b. One version, one supervisor tree

Two agents on one computer are still one computer, and the things that follow from that are rules in the agent, not
habits of whoever updates it ([_devices/machine](../../_devices/machine), "One machine").

**One version.** `upgrade`, run on any side, moves the whole PC to one exact release: the newest of the published one
and every side's installed one, never backwards. A distro hands the job to its Windows side, which upgrades its
distros first and itself last. Each side still downloads the tagged asset, probes it, swaps it, restarts and checks
what came up, with a rollback behind a failed start and a lock so two upgrades never share a download. The Windows
side also compares its sides every hour and asks the release channel every few hours, so a PC nobody touches is level
and current within the day; `updates --agent off` stops the second and never the first. A side can still end behind
when its own leg fails, and it then says so on the machine's page and is tried again with backoff.

**One supervisor tree.** The Windows side is started by its logon task and keeps each distro that has an agent
running through a held `wsl.exe` session: that session boots the distro at sign-in, keeps WSL from shutting the VM
down after its last client leaves, and restarts the distro's agent when it dies. A distro agent that finds a Windows
agent hands itself over and removes its own systemd entry, so every agent has exactly one starter. A distro whose
Windows side has no agent is its own root.

**Why the Windows side is the root.** It is the one environment the owner signs in to, the one whose supervisor runs
at sign-in, and the one that can start a distro; a distro cannot start Windows, and WSL shuts an idle distro down.

**What stays per environment.** Links, grants and pairings: a sandbox may be allowed to run commands in a distro and
not on Windows. So `uninstall` removes one side, and the Windows side keeps running while it still keeps a distro.

## 4. Why crossing is a parameter of `run_command`

From the Windows door, running a Linux command meant writing `wsl -d Arch -- sh -lc '…'` inside PowerShell's quoting;
from the distro, `pwsh.exe -Command '…'` inside sh's. Both are the kind of thing a model gets wrong once per turn.
`in: "wsl:<distro>"` and `in: "windows"` build argv on the machine — `wsl.exe --exec sh -lc <script>` passes the
script as one argument, and PowerShell through interop takes the same flags as on Windows — so the script the agent
wrote is the script that runs.

A crossed `cwd` is deliberately not checked against the door's roots. Roots are paths in this environment's
namespace, and a folder in the other one cannot be inside them; but a command's reach was never bounded by where it
started, only by the destructive classifier and the shell switch, and both still apply to the crossed command's text.
Saying so in the code is what keeps the next reader from "fixing" it into a refusal that grants nothing.

## 5. Considered and not done

- **One agent that serves both sides.** See §1: it cannot hold a distro's folder, and it would collapse two grants into
  one.
- **Upgrading one side at a time.** Each side upgrading itself from its own look at `latest` was how a PC ended with
  its sides on different releases. §3b makes the machine the unit an upgrade acts on.
- **A `machine` field in the wire payload.** A derived fact restated on the wire is a fact that can drift; the fold is
  cheap and both readers hold the contract that defines it.
- **Merging the two host capabilities into one card.** The card is the grant, and the grants differ per side. The
  Capabilities page says "one PC with …" on each instead.
- **Requiring the distro's own card for a command aimed at its checkout.** First written that way, and wrong: the
  owner connected a computer, not one of its shells, and a PC connected on its Windows side alone would print a
  command it could perfectly well have run. So a checkout verb CROSSES when it has to — `pathReach` answers
  `direct` for a door whose shell speaks the path's dialect and `wsl:<distro>` for the Windows door of the PC that
  has it, and the daemon passes that as `run_command`'s `in`. The distro's own card is still preferred where it
  exists: one hop fewer and no distro to infer.
  Two limits are worth stating. The gate is `facts.wslDistros`, because that field and `in` shipped in the same
  agent release — a machine that lists its distros is one that understands the crossing, and an older one gets the
  refusal rather than an argument it would reject. And two real distros stay a refusal that names them: nothing here
  knows which holds the folder, and guessing runs a build in the wrong environment.
- **Assuming a detached job survives a crossed call.** It does not, by default: `wsl.exe --exec sh -lc <script>` has
  WSL kill the session's processes as it exits, and the exit beat the background job to the fork — no build, and no
  log file to explain it. The rebuild line therefore ends with a second of foreground, which is all it takes for a
  started child to outlive the session.
