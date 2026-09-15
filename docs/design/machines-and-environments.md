# One PC, several environments: Windows and WSL as one machine

Written 2026-09-15 from the source as it stands. The question asked: a Windows PC with a WSL distro connects to a
sandbox twice — once from Windows, once from inside the distro — and every screen and every turn treated the two as
separate machines. The answer, stated once here and argued below: **a machine is the physical computer, an
environment is one OS install on it with its own agent and its own door, both agents stay, and the join is the
hostname plus the fact that one side is WSL.** Companion to the last two sections of
[capabilities.md](../architecture/capabilities.md).

## 1. Why the rows stay and the machine is a fold over them

The first instinct is one agent per PC. It does not survive file sync: Mutagen watching a folder in a distro's
filesystem has to run inside that distro (over `\\wsl.localhost` it is slow and blind to changes), and the Windows
side alone can neither hold that folder nor own the distro's login shell and PATH. So a distro keeps its own agent,
its own enrollment and its own host capability, with the owner's own switches on each: the grant for "run commands
in Arch" and the grant for "see my Windows screen" are two decisions.

What was wrong was never the rows; it was that nothing said they were one box. The fold is therefore a pure function
over the rows (`machinesOf`), computed wherever the rows are read, not a new record the daemon keeps. Nothing is
migrated, nothing is renamed, and a lone device is a machine of one environment keyed as itself, so its address does
not change.

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
since the first open door is as often the Windows one, which answers a `sh` line with a parse error. The Windows side's distro listing is what makes the second
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
- **Crossing instead of choosing, for a checkout command sent to the wrong door.** The daemon could wrap a `sh` line
  in `in: "wsl:<distro>"` rather than pick the distro's door. It would fail on every machine worth fixing: `in` is
  newer than the agents out there, and a dogfooding machine's agent is usually older than the sandbox asking, so the
  call comes back as "Input validation failed". Picking the door needs nothing of the agent, and a PC whose distro
  door is not connected gets the printed command, which is what it got before.
