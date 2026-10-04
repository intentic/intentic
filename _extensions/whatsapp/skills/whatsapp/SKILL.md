---
name: whatsapp
description: Read and send messages in the connected WhatsApp number's chats and groups via the whatsapp CLI, find contacts by name, read a chat's history, and help the user pair the linked device. Use when the user asks to send a WhatsApp message (to a person by name or number), reply or react in a chat or group, read what was said in a chat, fetch a file someone sent, or connect/pair WhatsApp.
---

# WhatsApp (connected)

This sandbox is paired to a WhatsApp number as a **linked device**. There is no API to curl: the connection
lives in a gateway process, so everything goes through the `whatsapp` CLI on your PATH.

This is an **unofficial** connection (the WhatsApp Web protocol). It is against WhatsApp's terms and the number
can be banned: never send bulk or unsolicited messages, and prefer replying over initiating. The number should
be a dedicated one, not the owner's personal number: remind them of that if it comes up.

## Setup (do this when nothing is paired yet)

1. The owner needs WhatsApp running on a dedicated number (spare phone, prepaid SIM, or eSIM).
2. They enter that phone number (with country code) on the WhatsApp capability card.
3. The card then shows a **pairing code**. On the phone: WhatsApp → `Settings` → `Linked devices` →
   `Link a device` → `Link with phone number instead` → type the code.
4. The card turns active within a few seconds. If the code expires before it is entered, a fresh one appears
   on the card: codes rotate, always use the one currently shown.

To unpair: remove the capability (the phone's Linked-devices list is cleaned up), or unlink from the phone.

## Naming a chat

Every `<chat>` below takes any of:

- a **name**: a contact's saved name, the name they gave themselves, or a group's subject. Quote names with
  spaces: `whatsapp send "Vicheta Samnang" hello`. A first name or part of one works when only one person
  matches; when several do, nothing is sent and the CLI lists them with their JIDs: pick one and send to the JID.
- a **phone number** with its country code (`+855 12 345 678`).
- a **JID** from `whatsapp chats` or `whatsapp contacts` (`…@s.whatsapp.net` or `…@lid` for a person,
  `…@g.us` for a group).

## Commands

- `whatsapp contacts <part of a name or number>`: who matches, one per line:
  `<jid> <dm|group> <name> <+phone> ~<the name they gave themselves>`. Use this first when the user names someone.
- `whatsapp chats [query]`: every chat known, most recent first, same columns.
- `whatsapp history <chat> [count]`: the chat's last messages (default 30), oldest first, each ending in its
  `[messageId]`. When fewer are stored, the phone is asked for older ones, which works only while it is online.
- `whatsapp send <chat> <text…>`: send a message.
- `whatsapp reply <chat> <messageId> <text…>`: send a message quoting an earlier one.
- `whatsapp react <chat> <messageId> <emoji>`: react to a message; `""` removes your reaction.
- `whatsapp send-file <chat> <path>`: send a workspace file; images arrive as photos, audio as playable audio,
  everything else as a document.
- `whatsapp send-voice <chat> <path>`: send audio as a voice note. An `.ogg`/`.opus` file goes as it is; other
  formats need ffmpeg, and the command says so when the sandbox lacks it.
- `whatsapp download <messageId>`: fetch a photo, voice note or document someone sent (the id arrives on the
  event as `extra.attachments[].id`, or from `history`) and print the saved path.

## What the gateway knows

It keeps what WhatsApp gave the device when it was paired (the address book, the chat list, recent messages)
and everything since, our own replies included, across restarts. It does not hold a chat's whole past: older
messages come from the phone, on request, through `history`. If a contact is missing, they may not be saved on
the phone; a phone number always works.

Do not message someone who never wrote to this number unless the owner asked you to, by name: unsolicited
first contact is the fastest way to get the number banned.

## Writing for WhatsApp

Replies are **plain text**. Markdown does not render: no headings, no tables, no `[label](url)`. WhatsApp's own
inline marks (`*bold*`, `_italic_`, `~strike~`, ` ``` `-fenced monospace) work in moderation. Short paragraphs,
bare URLs. Long replies are fine technically (the cap is huge) but nobody reads a wall on a phone: keep it tight.

## Being addressed

When someone DMs the number, @mentions it in a group, or replies to one of its messages, the gateway wakes an
agent conversation, shows "typing…" while you work, and **sends your reply for you when you finish**: so just
answer in plain text; do not also send it with the CLI. Use the CLI to act *elsewhere*: send a file, message a
different chat, react.

The event's `author.id` is the sender's phone number (digits, country code first) whenever WhatsApp let the
gateway learn it, and `author.name` is the owner's saved name for them when there is one. `history` holds the
chat's recent messages, yours marked `self`. A reply carries `extra.replyTo` (the quoted message's id, text and
author). A chat is one continuing conversation: follow-up messages keep talking to the same agent (with its
memory of the chat) until it goes quiet for a couple of hours.

Notes: `WhatsApp is not connected` from any command means the device is not paired, walk the owner through
Setup above. A `…@g.us` JID only accepts sends if the number is still in that group.
