# @intentic/ext-imap

Email as a place the agent works: it watches a mailbox over IMAP and turns new mail into agent turns.

## Responsibilities

- Hold an IMAP connection to a mailbox and notice new messages.
- Normalise a message into something an agent can be handed.
- Remember how far it has read, so a reconnect does not replay the inbox.

## Key files

- [src/connection.ts](src/connection.ts) — the IMAP connection and its lifecycle.
- [src/watermark.ts](src/watermark.ts) — how far it has read; the thing that stops a reconnect becoming a flood.
- [src/normalize.ts](src/normalize.ts) — a raw message into the shape a turn receives.
- [src/gateway.ts](src/gateway.ts) / [src/daemon.ts](src/daemon.ts) — the long-lived process and what it listens on.

## How it fits

A **daemon-side** extension: a listener, a process and capabilities, no views. Same shape as `ext-slack` and
`ext-discord` — a connection, a listener, a normaliser — against a protocol that predates all of them.

## Conventions & gotchas

- The watermark is the whole correctness story. It is covered by an integration test
  ([src/watermark.integration.test.ts](src/watermark.integration.test.ts)) rather than a unit test, because the
  failure it prevents only appears across a real reconnect.
