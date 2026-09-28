---
name: capabilities
description: Ask the owner, on a card in chat, to connect a capability the task needs (a connector, an account, Docker, a server, a device), to change a setting on one, or to replace a refused credential, via the `capabilities` CLI. Use whenever a task hits something this sandbox isn't connected to: check what's connectable, then raise the ask instead of describing manual setup steps.
---

# Missing capabilities

The sandbox connects to outside things through capability cards: connectors (GitHub, Notion, Stripe…),
browser accounts, databases, Docker, servers over SSH, the owner's own devices. When a task needs one that
isn't connected, **raise the ask in chat** with the `capabilities` command rather than telling the owner to go
set something up by hand. The card carries the setup: for a server, a CLI or an endpoint the connection's own
form sits inside the card, filled in with everything you passed, so the owner adds only the credential (or,
for SSH, keeps the key the sandbox generates and runs one command on the server).

## Commands

```sh
capabilities list                          # every connectable card, what is connected, and what this
                                           # workspace looks like it wants (read from its files)
capabilities request <card> --why "…"      # ask on a card in the owner's chat
    --target <site|host>                   # the site or host it is for, when the card holds several
    --set key=value                        # settings you know (a host, a user, a region); never a credential
capabilities request <connection> --set key=value --why "…"
                                           # change a setting on a connected one: a device switch, a Docker option
capabilities request <connection> --reconnect --why "…"
                                           # it is connected, but its credential is being refused
```

Every ask answers the same way:

- **exit 0: met.** The capability is live now (or already was, and the sentence says so): use it.
- **exit 1: refused or declined.** Nothing was raised (the sentence says why and what to do instead), or the
  owner said no. Carry on without it and say plainly what it would have enabled.
- **exit 3: still waiting.** The card is up and stays up after your turn ends. Carry on with everything that
  does not need it; when the owner finishes, the sandbox continues this conversation with the answer. Do not
  poll, and do not ask again: `needs` lists what is still waiting, and `needs cancel <id>` withdraws an ask the
  task no longer needs.

The call holds up to 90 seconds for a quick answer (`--wait <0..100>` changes that); a setup that takes the
owner longer (finding a token, signing in) simply answers later, in the conversation.

## How consent works: enforced, not promised

`request` connects nothing. It raises a card in the owner's chat, titled with the catalog's own words, with
your `--why` as the one line that is yours, and everything that happens next is the owner's: their click,
their credential, their setup flow. You never see a credential; the daemon watches for the connection and
answers you. What saving it does beyond storing a credential (a rebuild, a restart, a privileged runtime) is
said on the card before the press.

What that leaves you:

1. **Ask as soon as you know the task needs it**, ideally before you present a plan, so the owner answers
   everything at once instead of being interrupted step by step. Check `capabilities list` first.
2. **Say what you know.** `--target` and `--set` fill the card's form; an owner who only has to paste a token
   finishes in seconds. A credential never goes in `--set`: the card collects it.
3. **"Already connected" is checked against this turn.** A connection your persona leaves out, one for a
   different host, or one whose credential is refused is not "use it": the answer says which, and the next
   step (`grants request capability <id>`, a new connection for that host, `--reconnect`).
4. **One ask per capability.** A decline means continue without it. The daemon refuses a repeat ask for a card
   the owner already declined in this conversation.
5. **Nobody at the keyboard is not a no.** An unattended turn's ask waits in **Needs you** for the owner: finish
   what you can and note what is blocked on it.
