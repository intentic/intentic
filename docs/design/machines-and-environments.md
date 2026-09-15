# One PC, several environments: Windows and WSL as one machine

Written 2026-09-15 from the source as it stands. The question asked: a Windows PC with a WSL distro connects to a
sandbox twice — once from Windows, once from inside the distro — and every screen and every turn treated the two as
separate machines. The answer, stated once here and argued below: **a machine is the physical computer, an
environment is one OS install on it with its own agent and its own door, both agents stay, and the join is the
hostname plus the fact that one side is WSL.** Companion to the last two sections of
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
(`rog::wsl:archlinux`); `hostCardOf` takes a connection back to the card whose switches admit it
([schemas/hosts.ts](../../_shared/sandbox-contract/src/schemas/hosts.ts), `PeerDoor.cardOf`). A machine with one OS
install is therefore addressed exactly as it always was, and `HostSummary.environments` — native first, each with its
own liveness, version and facts — is what a page draws a row per and what a command picks from.

The old fold (`machinesOf` over device rows, joined on hostname plus WSL) remains only for a machine that reaches this
sandbox WITHOUT a card, which after stage 3 of this work is nothing at all.

## 2. Why hostname plus WSL is the join, and not hostname alone

WSL hands a distro the Windows machine's hostname, and that is the whole evidence: two rows with one hostname where
one of them says `wsl:<distro>` are one PC by construction. Two rows with one hostname where neither says so are two
machines that happen to be named alike (a laptop and the desktop that replaced it), and folding them would put one
machine's buttons on the other's row — the fault the fold existed to avoid.

The fact has to arrive at connect time. It used to ride only the sync report, which is `intentic-machine status
--json` behind "Run commands"; a card with that switch off could never say which environment it was, and the daemon's
fold read that silence as agreement. `HostFacts` carries `hostname` and `wsl` now, and an agent old enough to send
neither says nothing rather than something false.

## 3. What each screen does with it

The board's unit is the machine: one card, the environments as lines with their own state (a live Windows side and a
stopped distro have no single word for themselves), the containers once. The page's unit is the machine too, with the
environments as rows because each has an agent to update, a door to reconnect and an enrollment to revoke, and one
sandbox list because one engine serves every door: container verbs go through the first open door, folder verbs
through the environment whose report carries the pairing, and a command written for a path — the dev rebuild and the
dev reload, `sh` lines that `cd` into the checkout — through the environment that holds that path (`hostHoldingPath`),
reached directly where its own card is connected and by crossing from the Windows side where it is not. The first
open door is as often the Windows one, which answers a `sh` line with a parse error. The Windows side's distro listing is what makes the second
environment discoverable from the first: a distro not yet connected is a Connect link into the Linux card's add form,
named `<pc>-wsl-<distro>` so the two ids read as one PC everywhere, and that name is what flips the Linux connect
dialog to its PowerShell form.

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
