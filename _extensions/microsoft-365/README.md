# microsoft-365

The Microsoft 365 connection: one card per office user that gives the agent `m365`, a CLI for Outlook mail, the
Outlook calendar and OneDrive or SharePoint documents, plus a watcher that wakes automations when new mail arrives.
Sending mail, changing the calendar and uploading files wait for the owner's approval unless the owner's action
rules say otherwise.

```mermaid
flowchart LR
    card["Microsoft 365 card<br/>tenant · app · sign-in"] -->|"env per card"| m365(["m365 CLI<br/>bin/m365"])
    agent["Agent"] --> m365
    m365 -->|"device-code sign-in"| entra["Microsoft sign-in<br/>login.microsoftonline.com"]
    m365 --> graph["Microsoft Graph"]
    m365 -->|"held send, meeting change, upload"| approvals["Approvals queue"]
    m365 -->|"new sign-in, rotated token"| daemon["Daemon<br/>oauth-token route"]
    daemon --> card
    watcher["watcher process<br/>node dist/gateway.js"] -->|"inbox delta, every minute"| graph
    watcher -->|"mail"| automations["Daemon<br/>automations"]
```

- **Signing in.** The office registers its own app in its own Entra ID tenant and types the tenant and app ids on the
  card. `m365 auth login` runs Microsoft's device-code sign-in: the person opens Microsoft's page in their own
  browser, types a short code and signs in there, with their tenant's MFA and Conditional Access applying as usual.
  No redirect address is needed, which is why it works from a sandbox nothing can reach. The refresh token goes
  straight onto the card through the daemon's write-only `POST /capabilities/{id}/oauth-token` route, never into the
  chat, a file or a log. The card's manifest declares which field holds it and which settings it is bound to
  (`refreshToken`), and the daemon refuses a token for a card whose tenant, app, cloud or access level changed since,
  or from a caller not holding the card's current token.
- **Keeping signed in.** Microsoft hands out a new refresh token with every access token. The CLI and the watcher store
  each new one the same way; the older one stays valid, so two processes rotating at once do no harm. The one-hour
  access token is cached `0600` under the extension's runtime directory, keyed by a hash of the credential, so a run of
  commands does not sign in again each time.
- **Read only is real.** A read-only card asks Microsoft for read permissions only, and `m365` refuses every write
  before it has a token, approved or not.
- **What waits.** `microsoft365.mail.send` (send, reply, reply all, forward), `microsoft365.calendar.write` (create,
  change, cancel a meeting) and `microsoft365.files.upload` hold by default: the exact request, attachments and file
  bytes included, is frozen into the approvals queue with a plain description for the owner. `m365 action run` sends
  only that request, only once the owner set it running, and only once. `allow` or `deny` in the action rules (also
  as `microsoft365.*`) change that; the public-office preset sets all three to hold. Saving a draft in Outlook is not
  held, since it sends nothing.
- **Files.** Attachments and downloads are saved inside the workspace, for `fileq` to read, and never over an existing
  file. Downloads come from Microsoft's pre-authenticated storage address, fetched without the sign-in token. Uploads
  are up to 4 MiB (no upload sessions yet).
- **The watcher** polls the inbox's delta query once a minute (Graph's push needs a public address the sandbox lacks),
  only while an automation listens to `microsoft365`. The first poll records where the inbox stands, so connecting
  replays nothing; the cursor is saved only after a batch reached the daemon, so a crash can deliver a message twice
  but never skips one. A refused sign-in pauses it until someone signs in again.
- **Clouds.** The card offers Microsoft's worldwide cloud, US Government (GCC High) and the China cloud. Each pairs one
  sign-in host with one Graph host, so the token never goes to a different cloud's Graph. DoD is not offered. The
  card's credential is limited to its sign-in host and the Graph hosts.
- **Next to SharePoint (app-only).** The connectors pack's SharePoint card stays: it is an administrator's
  application access (best with `Sites.Selected`), acting as the app, never as a person. It cannot read anyone's mail
  or calendar. Use this card for a member of staff's own mail, calendar, OneDrive and the SharePoint libraries they can
  open.

The card is baked into the core image; the CLI and the watcher ship in the `messaging` image pack, next to Google
Workspace. Nothing talks to Microsoft until someone signs in.

## Connecting an office (for the Microsoft 365 administrator)

1. In the [Entra admin center](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade),
   open **App registrations → New registration**. Name it (for example "Intentic"), choose **Accounts in this
   organizational directory only**, and leave the redirect URI empty.
2. From the app's **Overview**, copy the **Directory (tenant) ID** and the **Application (client) ID** onto the
   Microsoft 365 card.
3. Under **Authentication → Advanced settings**, set **Allow public client flows** to **Yes**.
4. Under **API permissions → Add a permission → Microsoft Graph → Delegated permissions**, add:
   - read & write: `User.Read`, `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, `Files.ReadWrite.All`,
     `Sites.Read.All`, `offline_access`;
   - read only: `User.Read`, `Mail.Read`, `Calendars.Read`, `Files.Read.All`, `Sites.Read.All`, `offline_access`.

   These are delegated permissions: the agent can reach only what the signed-in person can. If your tenant does not
   let users consent to apps themselves, press **Grant admin consent**.
5. If Conditional Access blocks the device-code flow, allow it for this app (or for the people who will use it). The
   sign-in follows your tenant's policies; it does not get around them.
6. Save the card. In a chat you are watching, ask the agent to sign in (`m365 auth login`); open the page it gives you,
   type the code and sign in as the office user. Start a new chat afterwards, or press **Test** on the card, which reads
   who is signed in (`/me`).
7. Add the card again for another mailbox. Switching a card between read only and read & write needs a new sign-in.

An app that cannot use public client flows can instead put its **client secret** on the card (advanced) and a refresh
token from its own authorization-code sign-in in **Sign-in**; `m365 auth login` is then not used.

## Key files

- [intentic-extension.json](intentic-extension.json) — the card and its guide, the listener, the watcher process.
- [src/auth.ts](src/auth.ts) — device-code sign-in, token refresh and rotation, storage on the card.
- [src/commands.ts](src/commands.ts) — the command line: which flags each command reads, then [mail](src/mail.ts),
  [calendar](src/calendar.ts) and [documents](src/documents.ts).
- [src/actions.ts](src/actions.ts) — action rules, the frozen approval and its single run.
- [src/graph.ts](src/graph.ts) — Graph calls pinned to the card's cloud, bounded pagination, read-only refusal.
- [src/watch.ts](src/watch.ts) and [src/gateway.ts](src/gateway.ts) — the inbox watcher.
- [skills/microsoft365/SKILL.md](skills/microsoft365/SKILL.md) — what the agent is taught, with Polish office examples.

## Commands

```sh
pnpm --filter @intentic/ext-microsoft-365 build      # tsgo to dist/, which bin/m365 and the watcher run
pnpm --filter @intentic/ext-microsoft-365 test       # Graph and Microsoft's sign-in are mocked; nothing goes out
pnpm --filter @intentic/ext-microsoft-365 typecheck
```

Microsoft's references: [device-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code),
[refresh tokens](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens),
[Graph permissions](https://learn.microsoft.com/en-us/graph/permissions-reference),
[national clouds](https://learn.microsoft.com/en-us/graph/deployments).
