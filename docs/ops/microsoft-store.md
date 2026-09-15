# Publishing the desktop app to the Microsoft Store

**Every release submits itself.** `msstore-publish.yml` runs at the tag semantic-release pushed, points the
Store listing at that release's Windows installer and submits it for certification — the same shape as
`npm-publish.yml`, `action-publish.yml` and `webstore-publish.yml`, dispatched from `dispatch-publish.sh`
alongside them.

Until the listing exists there is nothing to submit to, so the publish step **skips loudly** (a warning
annotation on the run) instead of taking a release red. What follows is how to stop it skipping. It is done
once.

## What actually gets published

A Microsoft Store listing for an EXE installer holds **a URL, not a package**. Partner Center keeps the
package URL, downloads the binary from it to certify and scan, and hands the same URL to every customer who
installs from the Store. So a release publishes by pointing the listing at the versioned installer that
release already attached to its GitHub Release:

```
https://github.com/intentic/intentic/releases/download/v<version>/Intentic-<version>-x64-setup.exe
```

Nothing is built for the Store and nothing is uploaded to it. The file Microsoft certifies is the file a real
Windows session installed, deep-linked and uninstalled in `windows-smoke.yml` before the release was cut.

Two consequences worth knowing before touching anything:

- **The URL must be the versioned one.** Microsoft requires an immutable package URL and re-certifies (or
  pulls) a listing whose binary changed underneath it. The site's `/desktop/windows` vanity path always
  resolves to the newest release, which makes it the one URL that must never be submitted.
- **Updates stay ours.** A Store-hosted EXE is not Store-updated: copies installed from the Store update
  themselves through the app's own updater and `latest.json`, exactly like copies from the download page.

## The hard precondition: a code-signing certificate

**Microsoft does not sign EXE or MSI submissions.** An MSIX package gets the Store's certificate for free; an
installer gets nothing, and one that does not already carry an Authenticode signature chaining to a CA in the
Microsoft Trusted Root Program fails certification — days later, by email.

So the Store cannot go live before [windows-code-signing.md](windows-code-signing.md) does. That is the same
certificate that stops SmartScreen calling the download dangerous, so it was already the largest single fix
available to this product; the Store just gives it a second reason.

`publish-msstore.mjs` refuses before submitting anything if the release's installer is unsigned. It downloads
the asset from the URL it is about to hand over, checks it against the release's own `SHA256SUMS`, and reads
the PE's certificate table with `sign-windows.sh --check`.

## What is already wired

| Piece | Where |
| --- | --- |
| The submission: auth, package update, commit, poll, submit | `_tools/scripts/release/publish-msstore.mjs` |
| Runs on every release | `.github/workflows/msstore-publish.yml`, listed in `_tools/scripts/release/dispatch-publish.sh` |
| The installer it submits | `_tools/scripts/desktop/build-desktop.sh`, attached to the Release by `publish-github.sh` |
| Its name, in one place | `_tools/scripts/lib/desktop-artifacts.sh` |
| The Authenticode check | `_tools/scripts/build/sign-windows.sh --check` |
| "What's new", from the release notes | the `## What's new` contract, checked by `_tools/checks/release-headings.mjs` |
| Listing copy, field by field | [`_editor/desktop-app/STORE-LISTING.md`](../../_editor/desktop-app/STORE-LISTING.md) |
| The installer exit codes the listing points customers at | `_site/site/src/pages/docs/troubleshooting.astro` |

## The one-time setup

### 1. A developer account

<https://partner.microsoft.com/dashboard> — register as the account that should own the listing forever (the
organisation's, not a person's). There is a one-off registration fee; it has been roughly $19 for an
individual and $99 for a company, and Microsoft has changed it before, so read the page rather than this line.
A company account needs verifiable legal existence, which takes days, and it is the same identity check a
code-signing certificate needs — start both together.

### 2. Reserve the name

**Apps and games → New product → EXE or MSI app**, then reserve `Intentic`. The dashboard URL now contains the
**product id** (a long number); that is `MSSTORE_PRODUCT_ID`.

Under **Account settings → Organization profile → Legal info** (or the account overview) is the **Seller ID**;
that is `MSSTORE_SELLER_ID`. Both are identifiers, not credentials — they are repository *variables*, so the
run logs stay readable.

### 3. The first submission, by hand

The API can update a product's draft; it cannot create the product, fill a listing, answer an age-rating
questionnaire or upload a screenshot. So the first submission goes in through the dashboard, from
[STORE-LISTING.md](../../_editor/desktop-app/STORE-LISTING.md), with the package URL of the newest release.

Submit it and wait for certification to finish. Everything after this is the automation replacing one module.

### 4. An Entra ID application

The API authenticates as an application in the Microsoft Entra ID directory associated with the Partner Center
account, not as a person.

1. **Account settings → User management → Microsoft Entra applications** (associate a directory first if the
   account has none — Partner Center will create one at no charge).
2. **Add Microsoft Entra application** → create a new one, and give it the **Manager** role. A lesser role can
   read the draft and not submit it.
3. From that application: the **tenant id**, the **client id**, and a **client secret** you mint yourself.
   Those are `MSSTORE_TENANT_ID`, `MSSTORE_CLIENT_ID`, `MSSTORE_CLIENT_SECRET`.

Client secrets expire. Set a calendar reminder for the expiry you chose: an expired secret makes this workflow
fail with "Entra ID refused these credentials", which is clear, but it fails release after release until
somebody notices.

### 5. Tell the repository

**Settings → Secrets and variables → Actions**:

| Name | Kind | Value |
| --- | --- | --- |
| `MSSTORE_TENANT_ID` | secret | the directory the Entra app lives in |
| `MSSTORE_CLIENT_ID` | secret | the Entra application |
| `MSSTORE_CLIENT_SECRET` | secret | that application's secret |
| `MSSTORE_SELLER_ID` | **variable** | Partner Center account settings |
| `MSSTORE_PRODUCT_ID` | **variable** | the product's dashboard URL |

### 6. Prove it

Actions ▸ **msstore publish** ▸ Run workflow, with the last release tag as the ref. The log ends in
`submitted <version> to the Microsoft Store: submission <id>`, or says exactly why it did not. From then on,
nothing: every release dispatches it.

## What happens on every release

1. The version comes from the tag the workflow was dispatched at. A branch is refused — the Store submits a
   release, not a ref.
2. The installer is fetched from the Release, checked against `SHA256SUMS`, and checked for an Authenticode
   signature. Any of those failing stops the run before the Store is touched.
3. If a submission is **already in certification**, this release is not submitted. That is the normal case
   for a project that releases more often than Microsoft certifies (their documentation says up to three
   business days), so it is a warning annotation and a green run, not a failure: the next release carries it,
   or you dispatch this workflow by hand at that tag once the Store is idle.
4. Otherwise the listing's "What's new" is updated from the release notes (a refusal there is a warning — the
   release still reaches users through the package), the package module is replaced with this release's
   installer, committed, and — once the Store has finished scanning it — submitted.
5. A re-run is recovery, not a duplicate: a run that staged the package and died before submitting finishes
   the job on the next attempt, and a run whose release is already submitted exits green. An older tag
   dispatched over a newer one is refused outright.

## What certification will ask about

- **It installs Docker Desktop.** That is third-party software installed on the customer's machine, and it is
  the single thing most likely to draw a question. The certification notes in
  [STORE-LISTING.md](../../_editor/desktop-app/STORE-LISTING.md) say what is installed, from where, and that
  the user is asked first. Do not leave that field empty.
- **It requires an account.** A listing whose app cannot be evaluated without a sign-in needs test credentials
  in the submission. Mint a dedicated account for review rather than handing over a real one.
- **It downloads the WebView2 bootstrapper.** Tauri's NSIS installer fetches the WebView2 runtime from
  Microsoft when the machine has none, and Microsoft's rule is that a submitted installer must be
  standalone rather than a downloader. The rule is about the *app's* binaries, and WebView2 is a Microsoft
  component that Windows 11 already carries, so this has not been a problem — but if a reviewer objects, the
  fix is one field: `bundle.windows.webviewInstallMode` in `tauri.conf.json`, set to `offlineInstaller`, which
  embeds it and adds roughly 130 MB to every download.
- **Silent install.** The Store installs with `/S` and expects no window. NSIS returns from `/S` before a
  chained WebView2 bootstrapper has finished, which is a known wrinkle in this installer
  (`_tools/desktop-smoke-windows/src/app.ts` handles it by waiting on the process) rather than a certification
  failure.

## Why an EXE and not an MSIX

An MSIX would be signed by the Store for free, which would remove this path's only hard precondition. It was
not chosen, and the reasons are worth keeping:

- Tauri produces no MSIX, and the installers here are cross-compiled on Linux — the package would have to be
  assembled by hand from the build output, as a second artifact nothing else verifies.
- MSIX runs the app with filesystem and registry virtualization and Store-managed updates. This app installs
  Docker Desktop, turns on Windows features, spawns PowerShell as the user, registers a URL scheme and updates
  itself. Every one of those would need re-proving under the container, and the app's own updater would have
  to be turned off for Store copies only — a second lifecycle for the same binary.
- The EXE path submits the exact file that `windows-smoke.yml` installs, deep-links and uninstalls on a real
  Windows session before every release. An MSIX would ship something no job has ever installed.

If the certificate turns out to be the blocker that never clears, this is the trade to revisit — and it is a
revisit, not a migration: the listing, the account and the credentials above are the same either way.

## What is still not automated

Listing copy, screenshots, pricing, markets, the age rating and the certification notes. All of them are
dashboard state, all of them are in [STORE-LISTING.md](../../_editor/desktop-app/STORE-LISTING.md), and none
of them changes per release. The API can write them (`PUT /metadata`) — wiring that up would mean this
repository becomes the source of truth for the listing, which is worth doing the day the copy starts drifting.
