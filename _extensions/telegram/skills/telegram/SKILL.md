---
name: telegram
description: Read and send messages in the connected Telegram bot's chats via the Telegram Bot API, and help the user finish bot setup. Use when the user asks to send a Telegram message, reply in a chat or group, download a file someone sent, or connect a Telegram bot.
---

# Telegram (connected)

Authenticated with a bot token in `$TELEGRAM_BOT_TOKEN`. Talk to the Bot API with `curl`.
Base URL: `$TELEGRAM_API_URL` (it stands in for https://api.telegram.org/bot followed by the token), the token can be
IN that path, so never paste a constructed URL anywhere it could be read; always build it from the variable.

Every method accepts `POST` with a JSON body and answers `{"ok":true,"result":…}` or
`{"ok":false,"error_code":…,"description":"…"}`. Check `.ok`: a 400 with a plain-English `description` is how
Telegram reports almost everything.

## Setup (do this when no bot exists yet)

There is no app review and no public URL. In Telegram, message **@BotFather**:

1. `/newbot` → a display name, then a username ending in `bot` (e.g. `acme_intentic_bot`).
2. Copy the HTTP API token it prints and paste it onto the Telegram capability.
3. For a group: add the bot to the group. By default a bot in a group sees **only** messages that `@mention`
   it or reply to it: that is Telegram's privacy mode. To let it read everything, `/setprivacy` → pick the
   bot → `Disable`, then remove and re-add it to the group.
4. Nothing else. A private chat works from the first message the user sends.

Confirm it landed: `curl -s "$TELEGRAM_API_URL/getMe" | jq '.result | {id, username}'`

## Common commands

- Send a message (`<CHAT_ID>` is a number, negative for groups; a public channel can be `"@channelname"`):
  `curl -s -X POST -H "Content-Type: application/json" -d '{"chat_id":<CHAT_ID>,"text":"hello"}' "$TELEGRAM_API_URL/sendMessage"`
- Reply to a specific message:
  `curl -s -X POST -H "Content-Type: application/json" -d '{"chat_id":<CHAT_ID>,"text":"on it","reply_parameters":{"message_id":<MESSAGE_ID>}}' "$TELEGRAM_API_URL/sendMessage"`
- Post into a forum topic of a supergroup (the topic id rides in on the event as `extra.messageThreadId`):
  add `"message_thread_id":<THREAD_ID>` to the body above.
- React to a message with an emoji:
  `curl -s -X POST -H "Content-Type: application/json" -d '{"chat_id":<CHAT_ID>,"message_id":<MESSAGE_ID>,"reaction":[{"type":"emoji","emoji":"👀"}]}' "$TELEGRAM_API_URL/setMessageReaction"`
- Edit something you sent:
  `curl -s -X POST -H "Content-Type: application/json" -d '{"chat_id":<CHAT_ID>,"message_id":<MESSAGE_ID>,"text":"corrected"}' "$TELEGRAM_API_URL/editMessageText"`
- Send a file from the workspace:
  `curl -s -F chat_id=<CHAT_ID> -F document=@/work/report.pdf "$TELEGRAM_API_URL/sendDocument"`
- Download a file someone sent (`fileId` comes in on the event as `extra.attachments[].fileId`): two steps,
  because `getFile` hands back a path you then fetch:
  ```sh
  path=$(curl -s "$TELEGRAM_API_URL/getFile?file_id=<FILE_ID>" | jq -r .result.file_path)
  curl -s -o /work/incoming "$TELEGRAM_FILE_URL/$path"
  ```
- Look up a chat you have the id of:
  `curl -s "$TELEGRAM_API_URL/getChat?chat_id=<CHAT_ID>" | jq '.result | {id, type, title, username}'`

**A bot cannot read a chat's past messages.** There is no history endpoint: `getUpdates` is owned by the
gateway process, so do not call it: and what you were not told about, you cannot look up. If you need context
you do not have, ask in the chat.

## Writing for Telegram

When the gateway posts your answer for you (below), write **Markdown**: it is turned into Telegram's own
formatting, so `**bold**`, `_italic_`, `` `code` ``, fenced code with a language, `[label](url)`, `-` lists and `>`
quotes all show as meant. Headings become bold lines, and tables are redrawn as aligned code, so prefer a list.
When you send a message yourself with curl, it is plain text unless you set `"parse_mode":"HTML"` and escape `<`,
`>` and `&` in the text.

A message is capped at 4096 characters; the gateway splits a longer answer, code blocks kept whole.

## Being mentioned

When someone messages the bot privately, `@mentions` it in a group, replies to one of its messages, or replies to
anything in a request's reply chain it is answering, the gateway wakes an agent conversation and **posts your
answer into that chat for you**, pointing at the message it answers: just write it, and do not send it yourself
with curl. While you work, a status card shows your steps and checklist with a Stop button, so don't narrate each
step. Use the commands above to act *elsewhere*: react, send a file, message a different chat.

A private chat is one continuing conversation. In a group, each request is its own conversation: its reply chain,
named by the event's `thread` (`<topic>/<root message id>` in a forum topic, else the root message id). Replies in
the chain reach you with no new mention, and one sent while you work arrives in the same turn. To post into the
chain yourself, reply to its root: `"reply_parameters":{"message_id":<ROOT>}`, plus `"message_thread_id":<TOPIC>`
in a forum.

Notes: `chat not found` usually means the bot was never added to that chat, or the id is wrong, a group id is
negative and a supergroup's starts `-100`. `bot was blocked by the user` means exactly that; nothing you send
will arrive. `Forbidden: bot is not a member of the group chat` needs the user to add it back.
