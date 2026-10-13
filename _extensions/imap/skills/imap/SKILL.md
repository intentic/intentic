---
name: imap
description: Read email over IMAP and compose, reply to, or send mail through the connected SMTP account with approval by default.
---

# IMAP inbox (connected)

Server `$IMAP_HOST:$IMAP_PORT`, login `$IMAP_USERNAME` / `$IMAP_PASSWORD`. `curl` speaks IMAP over TLS (imaps://).
Auth on every command: `--user "$IMAP_USERNAME:$IMAP_PASSWORD"`. curl sends `--user` credentials verbatim:
special characters in the password (`#`, `@`, `&`, spaces) are fine as-is. Never URL-encode them and never
put credentials inside the imaps:// URL (URL parsing truncates at `#` and percent-decodes the rest).

- List mailboxes/folders: `curl -s --url "imaps://$IMAP_HOST:$IMAP_PORT" --user "$IMAP_USERNAME:$IMAP_PASSWORD"`
- Unread message UIDs in INBOX: `curl -s --url "imaps://$IMAP_HOST:$IMAP_PORT/INBOX" --user "$IMAP_USERNAME:$IMAP_PASSWORD" -X "SEARCH UNSEEN"`
- Recent since a date: `curl -s --url "imaps://$IMAP_HOST:$IMAP_PORT/INBOX" --user "$IMAP_USERNAME:$IMAP_PASSWORD" -X "SEARCH SINCE 01-Jan-2026"`
- Fetch a message's headers: `curl -s --url "imaps://$IMAP_HOST:$IMAP_PORT/INBOX;UID=<UID>;SECTION=HEADER" --user "$IMAP_USERNAME:$IMAP_PASSWORD"`
- Fetch a whole message: `curl -s --url "imaps://$IMAP_HOST:$IMAP_PORT/INBOX;UID=<UID>" --user "$IMAP_USERNAME:$IMAP_PASSWORD"`

Notes: SEARCH returns UIDs; then fetch by `;UID=`. Read-oriented. Gmail/Outlook need an app password, not the account password.
On `[AUTHENTICATIONFAILED]`: the `--user` form above is correct for ANY password, do not switch to URL-embedded
credentials or encoding. Confirm the var is set without printing it (`printf %s "$IMAP_PASSWORD" | wc -c`);
if it is, the stored password itself is wrong (or the provider requires an app password).
Live reactions: the sandbox also watches the configured mailbox (default INBOX) and can wake automations the
moment mail arrives: when the user wants to *react* to incoming email, suggest a "Listen (live)" automation
instead of a polling schedule.

## Outgoing email

Compose a JSON draft with `to` (address array), optional `cc`, `subject`, `text`, optional `attachments` (`path`, optional `name` and `contentType`), and for a reply the original `Message-ID` as `inReplyTo` and its `References` chain as `references`. Fetch the source message's headers over IMAP first; append its Message-ID to References. The sender is the connected IMAP username. Set SMTP host, port and STARTTLS or implicit TLS on the card; blank SMTP credentials reuse the IMAP credentials.

Run `node <imap-extension-root>/dist/send-cli.js <draft.json>` with `INTENTIC_WORKSPACE` pointing to the workspace root. The sender reads `.intentic/config/settings.json`. `imap.message.send` defaults to **hold** for this new send feature: it writes a `kind: "action"` item to `.intentic/config/approvals/` with the exact recipients, message and attachments. A fresh turn executing that approved action runs the same CLI with `--approval-id <id>` while the approval item is `running`; the draft digest must match. An explicit `actionRules["imap.message.send"] = "allow"` sends directly, and `deny` refuses. Never bypass a hold with raw SMTP commands. The approvals skill describes the queue and the owner's review.
