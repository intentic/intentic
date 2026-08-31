# @intentic/connector-runtime

The shared gateway runtime for the messaging connectors: the process shell, daemon client and reply painters
that ext-discord, ext-slack, ext-telegram, ext-whatsapp and ext-imap used to each carry a copy of.

## Responsibilities

- Run a connector's gateway process: reconcile provider connections against the daemon's listener state, on a
  30-second poll and on the daemon's `/reconcile` poke, so switching an integration on does not leave the bot
  deaf until the next tick: post liveness status, serve the loopback `/health` (and a connector's own control
  routes), die cleanly on signals.
- Publish process-local discovery and watermark files beneath `.intentic/local/runtime/extensions/<provider>/`; the
  tree is derived state and is never included in a workspace export.
- Speak the daemon's four listener routes once, typed against the contract's listener protocol: so a payload a
  connector sends is compile-checked against the schema the daemon parses with.
- Paint a streaming reply into a channel: one growing, rate-limit-aware message (or WhatsApp's deliberate
  buffer-and-send-once), one painter per matched automation: and, when a turn is not going to answer at all,
  say why instead of leaving the chat with typing dots that stopped.
- Serve the daemon's outbound door (`POST /deliver` on the loopback surface): a message the owner placed in a
  channel conversation between turns, carried into the channel through the connector's `deliver` hook: a
  connector without one answers 501 and the daemon tells the owner so.

## Key files

- [src/gateway.ts](src/gateway.ts), `runConnectorGateway`: the reconcile/status/health/shutdown shell, and the
  `GatewayHooks` seam a connector fills in (open, close, alive, fatal, phase, deliver).
- [src/daemon.ts](src/daemon.ts): the client for `/listeners/<provider>/{state,dispatch,failure,status}`.
- [src/painter.ts](src/painter.ts): the streaming and buffered painters, and the per-automation fan-out.
- [src/context.ts](src/context.ts): what a connector's own modules get from the process (daemon, log,
  workspace root).

## How it fits

One tier below the five messaging extensions and one above `@intentic/sandbox-contract`: the wire types come
from the contract's `listener-protocol`, this package adds the behavior both ends of that wire assume, and each
connector supplies only its provider truth: how to open a connection, when a failure is fatal, what its
capability card's status row should say. The daemon side of the same seam is the sandbox's
`extensions/listener.routes.ts`, which was always provider-generic; this package is the client half that had
been written five times.

## Conventions & gotchas

- **Divergence goes in the hooks, not the shell.** The shell must never learn a provider's name; the first
  `if (provider === …)` inside it is the failure mode this package exists to prevent. A connector that needs
  something new gets a new hook with a default, so the other four don't change.
- **The hold predicate is the shell's** (connect only while an enabled listener automation exists), and
  WhatsApp's opt-out (`connectWithoutAutomations`: pairing, the CLI, and unlink-on-idle demand a standing
  connection) is a declared flag, not a forked loop.
- The painters are **best-effort by design**: a failed paint kills that painter and reports once, because a
  lost live update must never crash the turn that produced it.
- Shutdown is capped at three seconds: a wedged provider close must not hold the process hostage, since the
  daemon's supervisor SIGTERMs the process group and follows with SIGKILL after a grace of its own.
