---
name: telegram
description: Read and send messages in the connected Telegram bot's chats via the Telegram Bot API, and help the user finish bot setup. Use when the user asks to send a Telegram message, reply in a chat or group, download a file someone sent, or connect a Telegram bot.
---

# Telegram (connected)

Authenticated with a bot token in `$TELEGRAM_BOT_TOKEN`. Talk to the Bot API with `curl`.
Base URL: `https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN` — the token is IN the path, so never paste a
constructed URL anywhere it could be read; always build it from the variable.

Every method accepts `POST` with a JSON body and answers `{"ok":true,"result":…}` or
`{"ok":false,"error_code":…,"description":"…"}`. Check `.ok` — a 400 with a plain-English `description` is how
Telegram reports almost everything.

## Setup (do this when no bot exists yet)

There is no app review and no public URL. In Telegram, message **@BotFather**:

1. `/newbot` → a display name, then a username ending in `bot` (e.g. `acme_intentic_bot`).
2. Copy the HTTP API token it prints and paste it onto the Telegram capability.
3. For a group: add the bot to the group. By default a bot in a group sees **only** messages that `@mention`
   it or reply to it — that is Telegram's privacy mode. To let it read everything, `/setprivacy` → pick the
   bot → `Disable`, then remove and re-add it to the group.
4. Nothing else. A private chat works from the first message the user sends.

Confirm it landed: `curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getMe" | jq '.result | {id, username}'`

## Common commands

- Send a message (`<CHAT_ID>` is a number, negative for groups; a public channel can be `"@channelname"`):
  `curl -s -X POST -H "Content-Type: application/json" -d '{"chat_id":<CHAT_ID>,"text":"hello"}' "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage"`
- Reply to a specific message:
  `curl -s -X POST -H "Content-Type: application/json" -d '{"chat_id":<CHAT_ID>,"text":"on it","reply_parameters":{"message_id":<MESSAGE_ID>}}' "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendMessage"`
- Post into a forum topic of a supergroup (the topic id rides in on the event as `extra.messageThreadId`):
  add `"message_thread_id":<THREAD_ID>` to the body above.
- React to a message with an emoji:
  `curl -s -X POST -H "Content-Type: application/json" -d '{"chat_id":<CHAT_ID>,"message_id":<MESSAGE_ID>,"reaction":[{"type":"emoji","emoji":"👀"}]}' "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setMessageReaction"`
- Edit something you sent:
  `curl -s -X POST -H "Content-Type: application/json" -d '{"chat_id":<CHAT_ID>,"message_id":<MESSAGE_ID>,"text":"corrected"}' "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/editMessageText"`
- Send a file from the workspace:
  `curl -s -F chat_id=<CHAT_ID> -F document=@/work/report.pdf "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/sendDocument"`
- Download a file someone sent (`fileId` comes in on the event as `extra.attachments[].fileId`) — two steps,
  because `getFile` hands back a path you then fetch:
  ```sh
  path=$(curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getFile?file_id=<FILE_ID>" | jq -r .result.file_path)
  curl -s -o /work/incoming "https://api.telegram.org/file/bot$TELEGRAM_BOT_TOKEN/$path"
  ```
- Look up a chat you have the id of:
  `curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getChat?chat_id=<CHAT_ID>" | jq '.result | {id, type, title, username}'`

**A bot cannot read a chat's past messages.** There is no history endpoint — `getUpdates` is owned by the
gateway process, so do not call it — and what you were not told about, you cannot look up. If you need context
you do not have, ask in the chat.

## Writing for Telegram

Replies stream out as **plain text**, so write plain prose: no `**bold**`, no `#` headings, no tables, no
`[label](url)` — those render literally. Short paragraphs, bare URLs, and a `-` list at most. Telegram's own
formatting exists (`parse_mode`) but a half-written message can't be parsed, so streamed replies never use it;
if you are sending a one-shot message yourself and really want formatting, set `"parse_mode":"HTML"` and escape
`<`, `>` and `&` in the text.

A message is capped at 4096 characters. Say less, or send more than one.

## Being mentioned

When someone messages the bot privately, `@mentions` it in a group, or replies to one of its messages, the
gateway wakes an agent conversation and **streams your reply into that chat for you** — in that case just
answer in plain text and do not send it yourself with curl. Use the commands above to act *elsewhere*: react,
send a file, message a different chat.

A chat is one continuing conversation: follow-up messages keep talking to the same agent (with its memory of
what was said) until it goes quiet for a couple of hours.

Notes: `chat not found` usually means the bot was never added to that chat, or the id is wrong — a group id is
negative and a supergroup's starts `-100`. `bot was blocked by the user` means exactly that; nothing you send
will arrive. `Forbidden: bot is not a member of the group chat` needs the user to add it back.
