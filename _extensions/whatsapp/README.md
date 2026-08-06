# @intentic/ext-whatsapp

WhatsApp as a place the agent works: paired to a dedicated number as a linked device, it reads chats and
groups, replies in them, and wakes when it is addressed.

## Responsibilities

- Hold a paired multi-device session per configured number and turn WhatsApp messages into agent turns.
- Run the pairing ceremony: request a code for the configured number and publish it until the phone links.
- Give the agent the ability to send text and files and to fetch received media, through the `whatsapp` CLI.

## Key files

- [src/client.ts](src/client.ts) — the baileys socket, the session store, pairing, and staying connected.
- [src/listener.ts](src/listener.ts) — which messages become a turn, and which are ignored.
- [src/stream.ts](src/stream.ts) — why the reply is deliberately NOT streamed (sent once, complete).
- [src/gateway.ts](src/gateway.ts) — the long-lived process, its status posts, and the control surface.
- [bin/whatsapp](bin/whatsapp) — the agent's CLI, forwarding to the gateway over loopback.
- [src/types.ts](src/types.ts) — the structural message shapes everything except client.ts works on.

## How it fits

A **daemon-side** extension: a listener, a process, a bin and capabilities, no views. Same shape as
`ext-discord`, `ext-slack` and `ext-telegram` — but the credential is a PAIRING, not a token: the capability
card collects a phone number, the gateway publishes a code through the status route, and the card shows it as
its pending detail until the phone links. One dependency (`baileys`, isolated to client.ts), because WhatsApp's
multi-device protocol is Signal-encrypted — this is the one connection that cannot be spoken with `fetch`.

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
- **Pairing codes rotate.** WhatsApp closes an unpaired socket after a while and each reconnect mints a fresh
  code — the card always shows the current one, so "enter the code you see now" is the whole instruction.
- Removing the capability logs the device out and wipes its session, so the phone's Linked-devices list stays
  clean and a re-add pairs fresh. A phone-number edit is treated the same way (it means a different phone).
