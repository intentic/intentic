# @intentic/ext-slack

Slack as a place the agent works: it reads channels, replies in thread, and reacts.

## Responsibilities

- Hold a gateway connection and turn Slack events into agent turns.
- Declare the event labels, filters and starter prompt the generic automation editor renders.
- Give the agent the ability to post, thread, react and read history.

## Key files

- [src/gateway.ts](src/gateway.ts): the connection, and staying on it.
- [src/listener.ts](src/listener.ts): which Slack events become a turn, and which are ignored.
- [src/client.ts](src/client.ts): the API surface the agent's tools sit on.

## How it fits

A **daemon-side** extension: a listener, a process and capabilities, no views. It runs inside the sandbox
alongside the agent, and the browser never talks to Slack.

The process shell (reconcile loop, daemon client, status posts, streaming reply painter) is
`@intentic/connector-runtime`, shared with the other messaging connectors; what lives here is only what Slack
is: Socket Mode, the `ack` contract, and the `:eyes:` acknowledgement.

## Conventions & gotchas

- Threading is not optional. A reply that leaves the thread turns a conversation into a channel-wide broadcast,
  which is the fastest way for an agent to become something people mute.
