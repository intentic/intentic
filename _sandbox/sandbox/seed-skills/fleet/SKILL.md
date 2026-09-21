---
name: fleet
description: Create sandboxes on the owner's intentic account from inside this one, via the `sandboxes` CLI, and read what the account already runs. Use when a task needs a SEPARATE sandbox — a second project, a specialized agent with its own tools and access, a box for a role that should not share this one's environment — instead of asking the owner to make one in the browser.
---

# The owner's other sandboxes

This sandbox can act on the account that owns it: list its sandboxes, and create new ones on the owner's own
computers. You reach that with the `sandboxes` command. The provisioning token behind it lives with the
daemon and is never in your environment, so nothing you can read or run creates a sandbox without the owner
saying yes to that exact one, in chat, first.

## Commands

```sh
sandboxes ls                                 # every sandbox on the account, and whether it ever came up
sandboxes create storefront \
    --on radarsu-rog \                       # which connected computer builds it; default: this one's
    --definition ./team/reviewer.sandbox.toml \
    --why "one line on why this job needs its own box"
```

`create` holds its connection through both slow halves — the owner deciding, then `ic` pulling an image and
starting a container out on the machine. Minutes, either one. Hold it open rather than timing it out; every
line the machine printed comes back with the answer, and when a create fails those lines are the diagnosis.

## When a new sandbox is the right answer

A sandbox is a machine with its own environment, its own connected services and its own workspace. Reach for
one when the difference is any of those:

- **Its own tools and access.** A role that needs a database connector, a different toolchain, or credentials
  this box has no business holding.
- **Its own workspace.** A second project, whose repos and history should not be mixed with this one's.
- **Its own blast radius.** Work you want to be able to throw away, or that should not share this box's cores.

If the difference is only *how a turn behaves* — which model, which folder, which tone, which tools of the
ones already here — that is a **persona** in this sandbox, not a new machine. Personas are free; a sandbox is
a container somebody's computer has to run.

## How consent works: enforced, not promised

Every create raises a card in the owner's chat naming the sandbox and the machine it would run on, and the
call waits there. The order matters and is the point:

1. **The card comes first.** Nothing is minted until it is answered yes. A no, or a card nobody answers,
   leaves the account exactly as it was — no row, no setup code, nothing to expire.
2. **Then the claim, spent at once.** A yes mints the sandbox's row and a single-use setup code, and that
   code goes straight to the machine. It is short-lived; nothing holds one.
3. **Then the machine builds it**, with `ic`, under the same run contract every other sandbox on that
   computer uses.

So a refusal is an answer, not an obstacle: report it and carry on without the sandbox. Do not ask twice for
the same one in a conversation.

## What it will not do

- **It never provisions hosted machines.** A new sandbox runs on a computer the owner has connected as a
  device. Nothing here can spend their hosted plan or their money.
- **It creates, it does not destroy.** There is no remove verb. Deleting a sandbox is the owner's, in their
  own UI — and a sandbox you made outlives this conversation and this connection.
- **It carries no credentials into the new box.** A definition names capabilities and secrets; it never
  carries their values, and the new sandbox's owner connects them there.

## Definitions: a sandbox as a file

`--definition` takes a `sandbox.toml` — the same document Sandbox ▸ Environment exports. It names the
workspace repo, the repositories to clone, the capabilities the box should have, the secret NAMES to fill in,
the overlay Dockerfile, and the agent settings that differ from their defaults. The new sandbox applies it on
first boot, on a workspace that arrived empty.

That is what makes a team of specialized agents a reviewable artifact rather than a sequence of clicks: write
the definition, commit it, and create from it. What a definition cannot carry is consent — the overlay lands
there as a draft the owner still approves, and credentials land as names to fill.

## If there is no account connection

`sandboxes` answers with a sentence saying so. Connecting it is the owner's, on a card:

```sh
capabilities request fleet --why "so I can bring up the reviewer sandbox we planned"
```

They mint a provisioning token at Settings ▸ Tokens and paste it into that card. Until they do, a second
sandbox is something to ask for in words, not something to reach for.
