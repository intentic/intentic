# Needs

A need is something an agent cannot finish its task without and only a person can provide: a connection, a secret's value, wider access, a tool in the image. The agent raises it once, the sandbox keeps it until someone answers, and the conversation hears the answer whenever it comes.

```mermaid
flowchart LR
    agent["Agent<br/>capabilities · secrets · grants · environment"] -->|"POST /needs/ask"| store(["needs store<br/>survives the turn and a restart"])
    browser["The person's browser<br/>ask_access"] -.->|"seen, not asked"| store
    store --> card["Card in the chat<br/>and on the board"]
    card -->|"the person answers<br/>in the card"| store
    store -->|"met while the call waits"| agent
    store -->|"met later"| wake["wake: steer the live turn<br/>or start the next one"]
```

## Why a need is not a parked card

A parked card (plan, question, permission, payment, a per-use credential) holds a turn at one moment: when the turn ends, the card ends. Connecting GitHub or pasting an API key takes minutes, and the person often answers after the agent has finished everything else. So a need is stored on its own ([`needs-store.ts`](../../_sandbox/sandbox/src/needs/needs-store.ts)), keeps its card answerable after the turn ends and across a restart, and wakes the conversation when it is met ([`needs.ts`](../../_sandbox/sandbox/src/needs/needs.ts)), through the same door a condition watch uses ([`wake-delivery.ts`](../../_sandbox/sandbox/src/agent/run/turn/wake-delivery.ts)).

## The agent's side

Every ask is one CLI call that answers in under 100 seconds, below the shell's 110-second cutoff:

| Command | Raises | Met when |
| --- | --- | --- |
| `capabilities request <entry> [--target T] [--set k=v] --why …` | `capability`: connect, reconnect a refused credential, or change a setting on a connected one (a device switch, a Docker engine option) | an instance of the entry (matching the target) comes live, or the change is applied |
| `secrets ask NAME --why … [--where …] [--link URL]` | `secret`: a value the person pastes into the card | the name resolves |
| `grants request capability\|folder\|shelf <what> --why …` | `grant`: something this conversation's persona or area withholds | the person allows it, for this conversation or on the persona |
| `secrets request <id> --why …` | `release`: a gated account or connector for the rest of the conversation | a named approver releases it |
| `environment propose <tool> --why …` | `environment`: overlay steps for the sandbox image; with `--pack`, the steps of an opt-in image pack of that name (`office`), met at once when the image already bakes it | the running container was built from an overlay carrying the tool, however it was approved (its card, the Environment card, one of several approvals before one rebuild); declined when it was rejected, removed or thrown away elsewhere |
| `automations propose <id> <source or --guard> --prompt … --why …` | `automation`: a watch or schedule to run unattended, held to the Automations page's own rules before the card goes up; the card shows what a ready-made source's check sees today ([`automation-need.ts`](../../_sandbox/sandbox/src/needs/kinds/automation-need.ts)) | a person approves it, which saves it switched on |
| the browser extension's `ask_access` | `grant` of a `site`, raised by the daemon as the call goes by ([`webext-peer.ts`](../../_sandbox/sandbox/src/webext/webext-peer.ts)) | that browser reports the site allowed, which only the person's click there can do |

`secrets generate NAME [--bytes N] [--format hex|base64url|alnum]` is not a need: a value the task can make for itself (a session key, a signing secret, a password it sets up) is made and kept by the daemon (`POST /secrets/generate`), and the agent gets its reference and length, never the value. Proposed environment steps are checked before a card goes up: an apt install without both build-cache mounts is refused with the shape to use ([`environment.ts`](../../_sandbox/sandbox/src/environment/environment.ts) `cacheProblem`).

The call holds while the person decides (90 seconds by default, never on an unattended turn) and answers one of three ways: met (exit 0, with what works in this turn and what arrives on the next), refused (exit 1, with a sentence to act on), or still open (exit 3). Still open means carry on with other work: the answer arrives in the conversation by itself, so the agent neither polls nor asks twice. Misuse, transport failures and unreadable answers exit 2 with the error on stdout: no verdict was reached, so correct the command or restore the daemon before retrying. `needs` lists a conversation's needs; `needs cancel <id>` withdraws one.

Before raising a card the daemon checks what the turn can already reach ([`turn-standing.ts`](../../_sandbox/sandbox/src/conversations/actor/turn-standing.ts), recorded as each turn is planned), so a capability that is connected but withheld by the persona, gated to an approver, or rejecting its credential is answered as exactly that, and the card offers the fix rather than a second connection.

## The person's side

- The card draws the need live, wherever it is: in the transcript where it was raised, pinned under the conversation while it is open, and on its agent's card on the board, whose tile counts it.
- It is answered in place. A connection's form opens inside the card with everything the agent could fill already filled and only the credential empty; a secret has one masked field whose value goes straight to the store and never into the transcript; a grant offers this conversation or the persona; an environment proposal shows its steps with Approve and Rebuild.
- A push names the conversation and what it needs, and is sent to the people who are away, not to nobody because someone else has a tab open.
- A conversation that came from a channel (Slack, Telegram, Discord…) hears it there too ([`need-channel.ts`](../../_sandbox/sandbox/src/needs/need-channel.ts)), with where to answer it and, for a secret, a warning not to paste it into the channel. A visitor's chat never does: nothing a need asks for is a stranger's to give.
- A pending plan names the conversation's open needs under itself, so the person answers them in the same sitting as the plan rather than one interruption at a time.
- Every yes still standing (what a grant widened, which credentials were released, whether its installs run unasked) is listed on the Sandbox hub's Access tab under What you have allowed, by conversation, each with Take back ([`standing-grants.ts`](../../_sandbox/sandbox/src/needs/standing-grants.ts), drawn by [`StandingGrants.vue`](../../_editor/web/src/features/sandbox/access/StandingGrants.vue)); it applies from the conversation's next turn, and for installs from its next install. A yes is kept until a person takes it back or the conversation is gone: a restart forgets none of them.
- That includes a credential gateway card's "Allow requests like this with <name> in this conversation", listed in the card's own words ("Requests like GET api.github.com/… with GitHub") and taken back by capability and rule. A yes a card writes mid-turn closes no need, so the daemon pushes a `grants` runtime change whenever a conversation's grants or releases move, and the list reads again.

## Where a person finds it

There is no one inbox. Each wait badges the rail tile of the place it is answered, so the tile a reader picks already says what kind of thing waits:

| Waiting | Counted on | Answered |
| --- | --- | --- |
| an open need, or a turn parked on a person (a plan, a question, a permission, a setup, a release, a hand-off) | the Agents tile, and the agent's own card on the board | in the card, in place or in the chat |
| a held automation wake with no countdown | the Agents tile; a card on the board | Start it or Drop it on that card, or in Approvals |
| a proposal, a failure or a hook set in the Approvals queue | the Approvals tile, and the phone's Review tab while that pack is on ([`owed.ts`](../../_extensions/approvals/src/owed.ts)) | on the Approvals page |
| an extension written in the workspace waiting for its yes | the sandbox chip ([`sandboxAttention.ts`](../../_editor/web/src/features/sandbox/overview/sandboxAttention.ts)) | on the Extensions tab, where its powers are read in full |

- Standing conditions of the sandbox (no backup, no AI account) stay on the sandbox chip too: they are health, not asks.
- 2026-10-04 to 2026-10-12 a Needs you inbox gathered all of these on one page and one rail tile, with `ViewRegistration.asks` letting an extension view add its rows; the Approvals tile badged nothing so the inbox could hold the one count. It left the editor: the rail already badged every place a wait is answered, and a tile for everything said less than the tile it duplicated. The store, the cards and the routes are unchanged. The page lives on, read-only, as the installable `intentic.needs` debugging extension ([`extensions/needs`](../../../extensions/needs)), a Sandbox hub tab that lists every need open and answered, the standing grants, the held wakes and the extensions waiting, each with its raw record.

## After the answer

- Met while the call still waits: the call answers, and nothing else happens.
- Met after the call answered: a live turn is steered with the outcome; a finished conversation is continued with it (the `continueWhenNeedMet` setting, on by default, since the person just asked for exactly this); a busy one queues it.
- Declined: a live turn is told; a finished conversation is not woken to hear a no.
- A grant, a release or a connection that only mounts on the next turn says so, and the conversation is continued as soon as its current turn ends. A site allowed in the person's browser is live at once, so the running turn hears it.

## State

| Place | Holds |
| --- | --- |
| `.intentic/records/needs.json` | every open need and the recent closed ones, with who answered and how the agent was told |
| `sandbox-secrets.json` (auth root) | secrets a person pasted into a card or added on the Secrets view without DevOps, and ones `secrets generate` made |
| `conversation-grants.json` (auth root) | what a person allowed one conversation beyond its persona, "allow installs for this conversation" from an install card, "allow <secret> anywhere in this conversation" from a host guard card, "allow everything in this conversation" from any permission card's Allow menu, and the credential gateway rules a card's "allow requests like this" stopped asking |
| `credential-releases.json` (auth root, [`credential-grants.ts`](../../_sandbox/sandbox/src/secrets/credential-grants.ts)) | credentials a named approver released to a conversation, until a take-back; mirrored in memory, loaded at boot |
