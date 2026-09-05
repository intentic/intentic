---
name: capabilities
description: Ask the owner, on a card in chat, to connect a capability the task needs (a connector, an account, Docker, a machine) via the `capabilities` CLI. Use whenever a task hits something this sandbox isn't connected to, check what's connectable, then raise the ask instead of describing manual setup steps.
---

# Missing capabilities

The sandbox connects to outside things through capability cards: connectors (GitHub, Notion, Stripe…),
browser accounts, databases, Docker, the owner's own devices. When a task needs one that isn't connected,
**raise the ask in chat** with the `capabilities` command rather than telling the owner to go set something
up by hand. The card does the setup handoff, and your command resumes the moment the connection is live.

## Commands

```sh
capabilities list                        # every connectable card, and whether it's connected
capabilities request <card> \
    --why "one line on why the task needs it"   # ask the owner on a card in their chat — and wait
```

`request` holds until it has a real answer. A `connected` answer means the capability is **live right now**:
its skill and tools are available from your next tool call, so continue the task with it in this same turn.
The wait can span the owner's whole setup (finding a token, a sign-in): hold the command open rather than
timing it out.

## How consent works: enforced, not promised

`request` connects nothing. It raises a card in the owner's chat: titled with the catalog's own words, your
`--why` as the one line that is yours: and everything that happens next is the owner's click and the
owner's setup flow. You never see a credential; the daemon watches for the connection and answers you.

What that leaves you:

1. **Ask when the task genuinely needs it, at the moment it needs it.** Check `capabilities list` first:
   asking for something already connected just answers "use it".
2. **One ask per capability.** A skip means continue without it: say plainly what the missing capability
   would have enabled and finish everything that doesn't depend on it. The daemon refuses repeat asks for a
   card the owner already skipped in this conversation.
3. **An expired ask is not a no.** Nobody was at the keyboard: finish what you can, note what's blocked,
   and ask again only if the owner shows up.
4. **"Didn't finish while you waited" may still finish.** Check `capabilities list` before touching the
   feature again: the connection often lands minutes later.
