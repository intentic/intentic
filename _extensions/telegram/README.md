# @intentic/ext-telegram

Telegram as a place the agent works: it reads chats and groups, replies in them, and wakes when it is messaged.

## Responsibilities

- Hold a long-polling connection per bot and turn Telegram messages into agent turns.
- Give the agent the ability to send, react, and move files in both directions.
- Keep enough of a chat's recent traffic to answer "why are you telling me this?", since Telegram will not.

## Key files

- [src/client.ts](src/client.ts) — the Bot API, the connection pool, and the poll loop.
- [src/listener.ts](src/listener.ts) — which messages become a turn, and which are ignored.
- [src/daemon.ts](src/daemon.ts) — the long-lived process this extension contributes.
- [src/stream.ts](src/stream.ts) — streaming a reply as it is generated rather than after it is finished.

## How it fits

A **daemon-side** extension: a listener, a process and capabilities, no views. It runs inside the sandbox
alongside the agent, and the browser never talks to Telegram.

Its shape deliberately mirrors `ext-slack` and `ext-discord` — same file names, same responsibilities — because
they are the same problem against three APIs, and a reader who has understood one should not have to relearn the
others. It carries **no dependencies at all**: the Bot API is HTTPS and JSON, and `getUpdates` in a loop is the
whole connection, so an SDK would buy a wrapper around `fetch` and cost a deploy tree.

## Conventions & gotchas

- **A bot cannot read a chat's past.** There is no history endpoint, so the context a turn receives is what this
  process watched go by — a ring per chat, in memory. A restart starts it empty, and in a group with privacy
  mode on it only ever holds the messages that mentioned the bot. Everything downstream should read `history`
  as "what we happened to see", not "what was said".
- **Only one reader per bot.** Telegram hands a bot's updates to exactly one poller or webhook. A second one
  anywhere — a colleague's script, a webhook left over from another tool — is a 409, which is why that error is
  reported to the owner rather than resolved by quietly deleting their webhook.
- **The connection starts at now, not at the backlog.** Telegram holds undelivered updates for 24 hours, so a
  gateway that polled from zero after a restart would answer a day of chatter at once, hours late.
- Replies are painted as **plain text**. A half-written message cannot be parsed, so a streamed reply can never
  set `parse_mode` — the skill and the starter prompt both tell the model to write prose rather than markdown.
- The bot token rides in the URL path, which makes it the one credential here that can leak by being *logged*.
  The activity sniffer records the method and drops the rest of the path for exactly that reason.
