# @intentic/ext-telegram

Telegram as a place the agent works: it reads chats and groups, replies in them, and wakes when it is messaged.

## Responsibilities

- Hold a long-polling connection per bot and turn Telegram messages into agent turns.
- Give the agent the ability to send, react, and move files in both directions.
- Declare the event labels, filters and starter prompt the generic automation editor renders.
- Keep enough of a chat's recent traffic to answer "why are you telling me this?", since Telegram will not.

## Key files

- [src/client.ts](src/client.ts): the Bot API, the connection pool, and the poll loop.
- [src/listener.ts](src/listener.ts): which messages become a turn, which are ignored, and how the reply is painted.
- [src/gateway.ts](src/gateway.ts), what Telegram plugs into the shared connector runtime: open/close a bot's poll loop, and when a failure is fatal.

## How it fits

A **daemon-side** extension: a listener, a process and capabilities, no views. It runs inside the sandbox
alongside the agent, and the browser never talks to Telegram.

The process shell (reconcile loop, daemon client, status posts, streaming reply painter) is
`@intentic/connector-runtime`, shared with `ext-slack`, `ext-discord`, `ext-whatsapp` and `ext-imap`; what lives
here is only what Telegram is. It carries **no vendor dependency**: the Bot API is HTTPS and JSON, and
`getUpdates` in a loop is the whole connection, so an SDK would buy a wrapper around `fetch` and cost a deploy
tree.

## Conventions & gotchas

- **A bot cannot read a chat's past.** There is no history endpoint, so the context a turn receives is what this
  process watched go by: a ring per chat, in memory. A restart starts it empty, and in a group with privacy
  mode on it only ever holds the messages that mentioned the bot. Everything downstream should read `history`
  as "what we happened to see", not "what was said".
- **Only one reader per bot.** Telegram hands a bot's updates to exactly one poller or webhook. A second one
  anywhere (a colleague's script, a webhook left over from another tool) is a 409, which is why that error is
  reported to the owner rather than resolved by quietly deleting their webhook.
- **The connection starts at now, not at the backlog.** Telegram holds undelivered updates for 24 hours, so a
  gateway that polled from zero after a restart would answer a day of chatter at once, hours late.
- Replies are painted as **plain text**. A half-written message cannot be parsed, so a streamed reply can never
  set `parse_mode`: the skill and the starter prompt both tell the model to write prose rather than markdown.
- The bot token rides in the URL path, which makes it the one credential here that can leak by being *logged*.
  The activity sniffer records the method and drops the rest of the path for exactly that reason.
