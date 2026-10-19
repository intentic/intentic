# Linked sandboxes

A link lets one of an owner's sandboxes hand tasks to another of theirs: the asking sandbox's agent calls that sandbox's `delegate` tool, and the task runs as a conversation of its own in the other sandbox, with that sandbox's repositories, connections and credentials, under terms only that sandbox's owner sets.

```mermaid
flowchart LR
    subgraph A["Asking sandbox"]
      agent["agent<br/>mcp__ops__delegate · wait · send"] --> children(["linked child<br/>on the roster"])
      children --> client["link client<br/>link card's token"]
    end
    subgraph B["Taking sandbox"]
      doors["link doors<br/>/link/*"] --> tasks(["task<br/>persona · approval · limits"])
      tasks --> turn["unattended turn<br/>own worktree, lands here"]
    end
    editor["Owner's editor<br/>signed in to both"] -. "pairs once" .-> client
    editor -. "mints the link" .-> doors
    client -->|"HTTPS, the far sandbox's own address"| doors
```

## The two halves

- **The taking side** holds an *inbound link* ([`inbound-links.ts`](../../_sandbox/sandbox/src/links/inbound-links.ts)): an `ilk_` token stored as its hash, the label of the sandbox that holds it, and its terms. The terms are the persona every task wears, whether each new task waits for the owner (`approve`), and how many turns an hour the link may start. The owner mints, re-terms and revokes links on Sandbox ▸ Access ▸ Programs, and answers tasks that wait there; the tab counts them.
- **The link doors** ([`links.routes.ts`](../../_sandbox/sandbox/src/links/links.routes.ts), `/link/*`) check the token themselves. They answer only for the conversations their own link opened: the link's task list is the whole of its reach. The doors cannot read files, list other conversations or change settings, and they can never land.
- **A task** ([`link-tasks.ts`](../../_sandbox/sandbox/src/links/link-tasks.ts)) opens a conversation named `link-…`. Its turns are unattended, isolated in their own worktree, wear the link's persona, and are drawn as a program's words (`<label> (linked sandbox)`). They also carry `outside` content, so the guard treats them as somebody else's words. A card such a turn raises waits for the taking sandbox's owner, except a plain question, which the asking agent may answer. The closing message of each turn is the task's report. A task keeps its opening words until its first turn is said; one a restart cut between filing and starting is started at boot from them, under the first try's message id, so a turn that did start is not started again (`startUnstartedTasks`). The link's hourly allowance is kept on the history volume, so a restart does not reset it.
- **The asking side** holds a `link` capability card under Your devices: the far address and the token, kept by the daemon and never put in the agent's environment. Each granted card is mounted on the turn's lease as a tool server named after it, as a computer's is ([`link-mounts.ts`](../../_sandbox/sandbox/src/links/link-mounts.ts)): `mcp__<card>__delegate` and `mcp__<card>__about`, reaching every runtime the same way. A hand-over ([`linked-children.ts`](../../_sandbox/sandbox/src/links/linked-children.ts)) files the task as a `linked` subagent on the parent's roster. `wait`, `send`, `answer` and `cancel` reach it there like any child. A follower long-polls the far side (`GET /link/conversations/{id}?after=<version>&wait=25`) and moves the record. The ending wakes the parent the way a spawned child's report does, marked as outside content, since it is another sandbox's agent's account. The follower list is on the history volume, so a restart picks it up again. A hand-over is filed there before the far side is asked, with the ask kept until it is answered: a restart in between asks again under the same request id, which the far side answers with the task it already took, so nothing over there is orphaned and nothing runs twice. A settled task keeps its report on file (the newest 50), so a `wait` after a restart still hands it.

## What a task costs

A task opens a conversation, and its first turn carries the taking sandbox's whole turn context: the project map, the instructions, the skills and the tools. The spike on 2026-10-13 drove this sandbox from outside, through its public address, with a control token: authenticate 0.43 s, start 0.30 s, the whole turn about 7 s. Its one-word answer (`pong`) ran on a 98,747-token context, nearly all of it written to the prompt cache on that first turn. So a link is for work worth a turn of its own, not for one-line lookups: batch small questions into one task, and a persona with a lean prompt makes every task through its link cheaper.

## Decisions

- **The editor pairs, the platform never does** (2026-10-13). The platform never holds a credential that drives a daemon ([topology.md](topology.md#trust-model)). The owner's editor is the one party already signed in to both sandboxes, so it mints the link on the taking side under the owner's own session there, and fills the card on the asking side ([`linkPairing.ts`](../../_editor/web/src/components/linkPairing.ts)). The card's fields stay, so a link can also be made by hand. An agent's `capabilities request link --target <sandbox>` raises the same pairing inside its card in the chat, with the named sandbox chosen, so one press links them and saves the card (2026-10-15).
- **A waiting task points at its Allow** (2026-10-15). A task that waits for the taking sandbox's owner has no conversation to read yet, so its row on the asking side opens the Linked sandboxes section of that sandbox's Access ▸ Programs ([`linkedSubagent.ts`](../../_editor/web/src/models/fleet/linkedSubagent.ts)), switched to it, rather than an empty transcript.
- **A link of its own, not a control token.** A `drive` control token would reach the taking sandbox's whole fleet, every transcript and every file. Its prompts would also read as the owner's own words. A link reaches only what it opened, and its words are always marked as outside content.
- **Not a runner.** A runner is the asking sandbox's own container: the conversation, credentials and landing stay with its parent, and runner mode rewrites `/work` from the parent. A linked task is the other way round. It belongs to the taking sandbox, and only its report comes back.
- **Device-like, not a device** (2026-10-13). To the owner, another sandbox is another place their agent can act, held to what that side allows, as a computer is. So it sits under Your devices and on the Devices page, a persona picks it on the same devices list, and its tools are named after it. It is not the `device` kind: a device dials in and enforces shell and screen switches on its own machine, while a link is dialled out to, and its terms are a persona, an approval and an hourly limit. The first cut was a `delegate(to)` tool in the subagents server, gated by the delegate shelf alone; the owner asked for this instead.
- **Not `spawn`.** `spawn` promises the child's work comes back into the parent's checkout. A linked task's work never does, so it gets its own verb (`delegate`) and its own row kind (`linked`). It shares the lifecycle verbs because supervising it is the same job.
- **No model setting of its own.** A task runs on the model the link's persona names, else the taking sandbox's default. Everything about what a link's tasks are is set on the link, on Sandbox ▸ Access ▸ Programs, not on a second page.
- **Unattended on purpose.** Nobody on the taking side is watching, so the task gets no signed-in account unless the link's persona carries one, and anything needing consent waits for that sandbox's owner.
- **Two hops at most** (`LINK_MAX_HOPS`). A task that came in over a link may be handed on once more. Past that, both sides refuse, so two sandboxes cannot pass one task back and forth for ever. The asking side counts hops from the root of the parent's family.
- **Speaker, not schema.** A linked task is drawn as the existing `program` speaker, not a new speaker kind. A newer daemon would otherwise send a speaker kind an older editor cannot parse, and the whole transcript would fail with it.

## Links between owners: not yet

Today both sandboxes must be one owner's: pairing needs a session on each, and the link's terms assume the person setting them trusts the other side as their own.

A link between owners (an agency and its client, one team and another) needs three things this design does not have, so it waits for a decision of its own:

1. **An identity for the asking sandbox**, not just a token. The taking side should be able to say "sandbox X of account Y" in its records and its approvals. The platform could sign that the way it signs an email identity assertion: an Ed25519 statement naming the asking sandbox, its account and a nonce, which the taking daemon checks with the platform's public key. Each owner opts in per link, as they opt a person in to email sign-in. The platform would vouch for *who is asking* and still never hold the credential.
2. **Terms that bind the far owner's data**: what a report may carry back (no file contents, a size cap, redaction through the privacy shield), and a record of every task the other owner's agent ran, kept by the taking side and readable by both.
3. **Money**: whose model allowance a task spends. Today it is the taking sandbox's, which is right for one owner and wrong for two.

Until then, a person in the other organization is reached the way people already are: as a member of the sandbox, with their own reach.

## Key files

- [inbound-links.ts](../../_sandbox/sandbox/src/links/inbound-links.ts): the taking side's store.
- [link-tasks.ts](../../_sandbox/sandbox/src/links/link-tasks.ts): what a task becomes there.
- [linked-children.ts](../../_sandbox/sandbox/src/links/linked-children.ts): the asking side's follower and roster records.
- [link-mounts.ts](../../_sandbox/sandbox/src/links/link-mounts.ts): each linked sandbox as a turn's tool server.
- [links.ts](../../_shared/sandbox-contract/src/schemas/links.ts): the wire shapes both sides share.
- [link-e2e.integration.test.ts](../../_sandbox/sandbox/src/links/tests/link-e2e.integration.test.ts): two sandboxes over HTTP, end to end.
