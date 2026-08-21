---
name: google
description: Gmail, Google Calendar, Drive, Docs, Sheets and Contacts for a connected Google account, read and search mail, send and reply, book and move meetings, find and fetch files, read and write documents and spreadsheets, look people up. Use whenever the user mentions their email, inbox, calendar, meetings, Drive, a Google Doc or a Google Sheet.
---

# Google Workspace (connected)

Everything goes through **`gw`**, already authenticated for this account. Run `gw` for the groups, `gw <group>`
for a group's commands and their flags: that help is generated from the tool itself, so it is never stale.

This connection is `${id}` (`$GOOGLE_EMAIL`). If several Google accounts are connected, every command takes
`--account ${id}`; with only one, leave it off. `gw accounts` lists them.

## The shape of every command

```
gw [--account NAME] [--json] <group> <command> [flags]
```

`--json` gives Google's own response instead of the summary lines: reach for it when you need a field the
summary does not print. Otherwise prefer the default: it is one line per thing and far cheaper to read.

## Mail

```
gw mail search "from:ana is:unread newer_than:7d" -n 20
gw mail read <messageId>
gw mail thread <threadId>
gw mail send --to a@x.com,b@y.com --subject "Q3 numbers" --body "…" [--cc] [--bcc] [--attach report.pdf]
gw mail reply <messageId> --body "…" [--all]
gw mail draft --to a@x.com --subject "…" --body "…"
gw mail label <messageId> --add Work --remove INBOX      # removing INBOX is what archiving is
gw mail trash <messageId>
gw mail attachments <messageId> [--download ./dir]
gw mail labels
```

- The search string is **Gmail's own syntax**: `from:`, `to:`, `subject:`, `has:attachment`, `is:unread`,
  `newer_than:7d`, `label:…`. Use it; it is far more precise than filtering afterwards.
- A body with newlines belongs in a file: `--body-file draft.txt`. Shell quoting mangles multi-line text.
- `reply` keeps the thread and the subject for you. `--all` keeps everyone who was on it.
- Ids from `search` are what `read`, `reply`, `label` and `trash` take.

## Calendar

```
gw cal list --from now --to +7d              # what is on
gw cal calendars
gw cal show <eventId>
gw cal create --title "Review" --start "tomorrow 14:00" --end "+1h" --attendees ana@x.com --meet
gw cal update <eventId> --start "tomorrow 15:00"
gw cal delete <eventId>
gw cal busy --emails ana@x.com,sam@x.com --from now --to +3d
```

Times accept `now`, `+2h` / `-30m` / `+3d` / `+1w`, `today 14:00`, `tomorrow`, `2026-08-12`,
`2026-08-12 14:00`, or a full RFC-3339 timestamp. **A bare time means the calendar's own timezone**, not the
sandbox's: so `--start "tomorrow 09:00"` is 9am where the owner is. A bare date makes an all-day event.

Guests are notified automatically on create (when there are any), update and delete. Say so before you do it.

## Drive

```
gw drive search "quarterly budget" -n 25     # plain words search names AND contents
gw drive ls [folderId]
gw drive get <fileId> --out ./local.md [--as md|txt|pdf|docx|html|csv|xlsx]
gw drive put ./report.pdf --folder <folderId>
gw drive mkdir "2026 Reports" [--folder parentId]
gw drive mv <fileId> --folder <folderId>
gw drive rm <fileId>                          # to the bin, restorable
gw drive share <fileId> --email ana@x.com --role reader|commenter|writer [--notify]
gw drive who <fileId>
gw drive link <fileId>
```

`get` with no `--out` prints the file, which is usually what you want for text. Google-native files are
converted on the way out: a Doc defaults to markdown, a Sheet to CSV, Slides to PDF. A real Drive query
(`name contains 'x' and trashed = false`) is passed through as written if you need one.

## Docs and Sheets

```
gw docs read <documentId>
gw docs create --title "Weekly notes" [--text "…" | --from notes.md]
gw docs append <documentId> --from more.md
gw docs replace <documentId> --find "TBD" --with "2026-09-01"

gw sheets tabs <spreadsheetId>
gw sheets read <spreadsheetId> --range "Sheet1!A1:D50"      # prints CSV
gw sheets write <spreadsheetId> --range "Sheet1!A1" --csv rows.csv
gw sheets append <spreadsheetId> --values "ana,7,done"
gw sheets clear <spreadsheetId> --range "Sheet1!A2:D"
gw sheets create --title "Tracking"
```

Sheet writes go in as if typed: `=SUM(A1:A9)` becomes a formula, `2026-08-12` becomes a date. Pass `--raw` to
store text exactly as given instead.

Docs editing is read, create, append and find-replace: not styling, tables or images. For anything past that,
write the content and let the owner format it.

## Contacts

```
gw contacts search "ana"
gw contacts list -n 100
```

Use this before writing to someone whose address you are unsure of. Never guess an email address.

## When this connection is read-only

The card has a Read & write / Read only setting. On a read-only connection every command that sends, edits,
moves or deletes refuses with a sentence saying so: that is the owner's choice, not a fault. Say what you
would have done and let them change the setting if they want it.

## Acting as someone else

On a **company** connection (a Workspace service account), `--as someone@company.com` runs the command as that
person. On a personal connection there is nobody else to be, and it will say so.

## If nothing is connected yet

`gw accounts` says so. The owner adds the **Google Workspace** card under Capabilities; its guide walks through
the Google Cloud console. If they would rather not use Google's OAuth playground, offer them this instead:

```
gw auth login --client-id <id> --client-secret <secret>
```

It prints a URL to approve and then the refresh token to paste onto the card. Approving in this sandbox's own
browser completes it here; approving in their own browser lands on a page that cannot load, and pasting **that
whole address** into `gw auth exchange --code "<url>"` finishes it just as well.

One failure is worth recognising on sight: **"Google rejected the refresh token"**. It almost always means the
OAuth consent screen was left in `Testing`, where Google expires refresh tokens after 7 days. The fix is to set
it to `In production` in the Google Cloud console and get a fresh token.

## Watching

If the owner has an automation with Google as its source, new inbox mail and imminent calendar events start
agent runs on their own. Nothing needs to be polled from here: this tool is for acting, not for waiting.
