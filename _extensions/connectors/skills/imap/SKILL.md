---
name: imap
description: Read an email inbox over IMAP — list folders, search, and fetch messages — with curl. Use when the user asks about their email or inbox.
---

# IMAP inbox (connected)

Server `$IMAP_HOST:$IMAP_PORT`, login `$IMAP_USERNAME` / `$IMAP_PASSWORD`. `curl` speaks IMAP over TLS (imaps://).
Auth on every command: `--user "$IMAP_USERNAME:$IMAP_PASSWORD"`. curl sends `--user` credentials verbatim —
special characters in the password (`#`, `@`, `&`, spaces) are fine as-is. Never URL-encode them and never
put credentials inside the imaps:// URL (URL parsing truncates at `#` and percent-decodes the rest).

- List mailboxes/folders: `curl -s --url "imaps://$IMAP_HOST:$IMAP_PORT" --user "$IMAP_USERNAME:$IMAP_PASSWORD"`
- Unread message UIDs in INBOX: `curl -s --url "imaps://$IMAP_HOST:$IMAP_PORT/INBOX" --user "$IMAP_USERNAME:$IMAP_PASSWORD" -X "SEARCH UNSEEN"`
- Recent since a date: `curl -s --url "imaps://$IMAP_HOST:$IMAP_PORT/INBOX" --user "$IMAP_USERNAME:$IMAP_PASSWORD" -X "SEARCH SINCE 01-Jan-2026"`
- Fetch a message's headers: `curl -s --url "imaps://$IMAP_HOST:$IMAP_PORT/INBOX;UID=<UID>;SECTION=HEADER" --user "$IMAP_USERNAME:$IMAP_PASSWORD"`
- Fetch a whole message: `curl -s --url "imaps://$IMAP_HOST:$IMAP_PORT/INBOX;UID=<UID>" --user "$IMAP_USERNAME:$IMAP_PASSWORD"`

Notes: SEARCH returns UIDs; then fetch by `;UID=`. Read-oriented. Gmail/Outlook need an app password, not the account password.
On `[AUTHENTICATIONFAILED]`: the `--user` form above is correct for ANY password — do not switch to URL-embedded
credentials or encoding. Confirm the var is set without printing it (`printf %s "$IMAP_PASSWORD" | wc -c`);
if it is, the stored password itself is wrong (or the provider requires an app password).
