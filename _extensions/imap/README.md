# @intentic/ext-imap

Email as a place the agent works: it watches a mailbox over IMAP and turns new mail into agent turns.

## Responsibilities

- Hold an IMAP connection to a mailbox and notice new messages.
- Normalise a message into something an agent can be handed.
- Declare the event labels, filters and starter prompt the generic automation editor renders.
- Remember how far it has read, so a reconnect does not replay the inbox.

## Key files

- [src/connection.ts](src/connection.ts) — the IMAP connection and its lifecycle.
- [src/watermark.ts](src/watermark.ts) — how far it has read; the thing that stops a reconnect becoming a flood.
- [src/normalize.ts](src/normalize.ts) — a raw message into the shape a turn receives.
- [src/gateway.ts](src/gateway.ts) — what IMAP plugs into the shared connector runtime: open/close an account's connection, and when a failure is fatal.

## How it fits

A **daemon-side** extension: a listener, a process and capabilities, no views. The process shell is
`@intentic/connector-runtime`, shared with the chat connectors; what lives here — a connection, a normaliser, a
watermark — is IMAP against a protocol that predates all of them.

## Conventions & gotchas

- The watermark is the whole correctness story. It is covered by an integration test
  ([src/watermark.integration.test.ts](src/watermark.integration.test.ts)) rather than a unit test, because the
  failure it prevents only appears across a real reconnect.
- The "New email" starting point is declared here (`contributes.automationTemplates`), beside the listener it
  fires on. The source's starter and the template's prompt describe the same payload, so they are one package's
  problem rather than two.
