# @intentic/ext-whatsapp

WhatsApp as a place the agent works: paired to a dedicated number as a linked device, it reads chats and
groups, replies in them, and wakes when it is addressed.

## Responsibilities

- Hold a paired multi-device session per configured number and turn WhatsApp messages into agent turns.
- Run the pairing ceremony and report WHERE IT STANDS every few seconds — waiting, holding a live code, or
  refused — until the phone links.
- Declare the event labels, filters and starter prompt the generic automation editor renders.
- Give the agent the ability to send text and files and to fetch received media, through the `whatsapp` CLI.

## Key files

- [src/client.ts](src/client.ts) — the baileys socket, the session store, pairing, and staying connected.
- [src/listener.ts](src/listener.ts) — which messages become a turn, and which are ignored.
- [src/gateway.ts](src/gateway.ts) — what WhatsApp plugs into the shared connector runtime, its pairing status, and the control surface. Also why the reply is deliberately NOT streamed (sent once, complete — in [src/listener.ts](src/listener.ts)).
- [bin/whatsapp](bin/whatsapp) — the agent's CLI, forwarding to the gateway over loopback.
- [src/types.ts](src/types.ts) — the structural message shapes everything except client.ts works on.

## How it fits

A **daemon-side** extension: a listener, a process, a bin and capabilities, no views. Same shape as
`ext-discord`, `ext-slack` and `ext-telegram` — but the credential is a PAIRING, not a token: the capability
card collects a phone number, the gateway publishes the ceremony's state through the status route, and the card
stands the reader in front of it — the code set big and copyable — until the phone links. One dependency
(`baileys`, isolated to client.ts), because WhatsApp's multi-device protocol is Signal-encrypted — this is the
one connection that cannot be spoken with `fetch`.

Because of that, **this connector is the only one whose "active" cannot be read off a stored config**: a phone
number is something anybody can type, and whether a phone ever linked is a fact only this process holds. So the
card's status inverts the usual default — WhatsApp is `pending` until a session reports itself `ready`, and a
silent gateway counts as pending too. The old rule (pend only while holding a code, active otherwise) made
every gap in the ceremony — the seconds before the first code, the seconds between a dead code and its
replacement, a restarting gateway, a number WhatsApp had refused — render as a connected green card, which is
how an owner could add WhatsApp and never be shown a code at all.

## Conventions & gotchas

- **This connection is unofficial** — the WhatsApp Web protocol, against WhatsApp's terms; numbers get banned.
  The capability card says so and asks for a dedicated number. The design keeps the number's fingerprint human:
  replies send once behind a typing indicator (no live-edit painting), and the skill teaches reply-don't-broadcast.
- **Connects while a connector exists, automations or not** — deliberately unlike the other gateways' hold
  predicate. Pairing starts the moment the capability is added, the `whatsapp` CLI needs the socket without any
  automation, and WhatsApp unlinks a device that stays offline for weeks. gateway.ts opens with the reasoning.
- **There is no history, cryptographically.** The `history` on an event is the per-chat ring of what this
  process watched go by; a restart starts it empty. Media downloads reach back only as far as the raw-message
  cache, because decrypting media needs the original envelope.
- **Pairing codes rotate, and a code dies with the socket that minted it.** WhatsApp closes an unpaired socket
  after a while and each reconnect mints a fresh one. The card is swapped in place as that happens, and the old
  code is pulled the moment its socket closes rather than being left up for the minute of backoff before its
  replacement — a dead code on screen is worse than none, because the owner spends the walk through the phone's
  menus on it. "Enter the code you see now" is the whole instruction.
- **An unregistered session dir is wreckage, not a session.** Half-written keys and an ephemeral pairing key
  belonging to a code nobody used are worthless, and resuming them is how a re-add inherits a dead handshake —
  so open() keeps a stored session only once `registered` is true and starts clean otherwise.
- Removing the capability logs the device out and wipes its session, so the phone's Linked-devices list stays
  clean and a re-add pairs fresh. A phone-number edit is treated the same way (it means a different phone).
