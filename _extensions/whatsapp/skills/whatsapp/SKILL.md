---
name: whatsapp
description: Read and send messages in the connected WhatsApp number's chats and groups via the whatsapp CLI, and help the user pair the linked device. Use when the user asks to send a WhatsApp message, reply in a chat or group, fetch a file someone sent, or connect/pair WhatsApp.
---

# WhatsApp (connected)

This sandbox is paired to a WhatsApp number as a **linked device**. There is no API to curl — the connection
lives in a gateway process — so everything goes through the `whatsapp` CLI on your PATH.

This is an **unofficial** connection (the WhatsApp Web protocol). It is against WhatsApp's terms and the number
can be banned: never send bulk or unsolicited messages, and prefer replying over initiating. The number should
be a dedicated one, not the owner's personal number — remind them of that if it comes up.

## Setup (do this when nothing is paired yet)

1. The owner needs WhatsApp running on a dedicated number (spare phone, prepaid SIM, or eSIM).
2. They enter that phone number (with country code) on the WhatsApp capability card.
3. The card then shows a **pairing code**. On the phone: WhatsApp → `Settings` → `Linked devices` →
   `Link a device` → `Link with phone number instead` → type the code.
4. The card turns active within a few seconds. If the code expires before it is entered, a fresh one appears
   on the card — codes rotate, always use the one currently shown.

To unpair: remove the capability (the phone's Linked-devices list is cleaned up), or unlink from the phone.

## Commands

- `whatsapp chats` — every chat this connection knows: `<jid> <group|dm> <name>` per line. Groups are complete;
  direct chats appear only after their first message (WhatsApp has no directory to list).
- `whatsapp send <chat> <text…>` — send a message. `<chat>` is a JID from `whatsapp chats`
  (`4915112345678@s.whatsapp.net` for a person, `…@g.us` for a group) or a bare phone number with country code.
- `whatsapp send-file <chat> <path>` — send a workspace file; images arrive as pictures, everything else as a
  document.
- `whatsapp download <messageId>` — fetch a photo/voice note/document someone sent (the id arrives on the event
  as `extra.attachments[].id`) and print the saved path. Only recently received messages can be fetched.

## What you cannot do

- **Read a chat's past.** WhatsApp is end-to-end encrypted; there is no history to fetch. The `history` on an
  event is only what the gateway watched go by while running. If you lack context, ask in the chat.
- **Message someone who never wrote to a chat you can see** — you can, but don't: unsolicited first contact is
  the fastest way to get the number banned.

## Writing for WhatsApp

Replies are **plain text**. Markdown does not render — no headings, no tables, no `[label](url)`. WhatsApp's own
inline marks (`*bold*`, `_italic_`, `~strike~`, ` ``` `-fenced monospace) work in moderation. Short paragraphs,
bare URLs. Long replies are fine technically (the cap is huge) but nobody reads a wall on a phone — keep it tight.

## Being addressed

When someone DMs the number, @mentions it in a group, or replies to one of its messages, the gateway wakes an
agent conversation, shows "typing…" while you work, and **sends your reply for you when you finish** — so just
answer in plain text; do not also send it with the CLI. Use the CLI to act *elsewhere*: send a file, message a
different chat.

A chat is one continuing conversation: follow-up messages keep talking to the same agent (with its memory of
the chat) until it goes quiet for a couple of hours.

Notes: `WhatsApp is not connected` from any command means the device is not paired — walk the owner through
Setup above. A `…@g.us` JID only accepts sends if the number is still in that group.
