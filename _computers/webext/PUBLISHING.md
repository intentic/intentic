# Publishing the browser extension

**Every release publishes itself.** `webstore-publish.yml` builds this package at the tag semantic-release
pushed, packs `dist/` into a zip, uploads it to the Chrome Web Store and submits it for review — the same
shape as `npm-publish.yml` and `action-publish.yml`, dispatched from `dispatch-publish.sh` alongside them.

Until the listing exists there is nothing to upload to, so the publish step **skips loudly** (a warning
annotation on the run) instead of taking a release red. What follows is how to stop it skipping. It is done
once.

---

## What is already wired

| Piece | Where |
| --- | --- |
| Build → `dist/` (three bundles, static files, stamped manifest) | `package.json` `build` |
| `dist/` → `dist.zip`, reproducible, no `zip` binary needed | `scripts/pack.mjs` |
| Manifest version derived from the release version | `scripts/stamp-manifest.mjs`, `_tools/scripts/packages.sh` |
| Icons, rendered from one SVG | `scripts/render-icons.mjs` → `static/icons/` |
| Upload + submit | `_tools/scripts/publish-webstore.mjs` |
| Runs on every release | `.github/workflows/webstore-publish.yml`, listed in `_tools/scripts/dispatch-publish.sh` |
| Listing copy, field by field | [STORE-LISTING.md](STORE-LISTING.md) |
| Privacy policy the listing must link | `_site/site-content/src/legal.ts`, section *The browser extension* |
| The page the listing links to | `_site/site/src/pages/docs/your-browser.astro` |

**The version is not in the tree.** Every first-party `package.json` here stays at `0.0.0` and CI stamps the
release version onto it; `static/manifest.json` carries `0.0.0` for the same reason and the build derives the
real number from the stamped package. A locally-built extension therefore says `0.0.0`, which is correct — it
is not a release. The store refuses an upload whose version is not strictly greater than the published one, so
never publish a hand-built zip: it would burn a version number the pipeline then cannot use.

---

## The one-time setup

### 1. A developer account (~10 minutes, $5)

<https://chrome.google.com/webstore/devconsole> — sign in as the account that should own the listing forever
(the organisation's, not a person's), accept the agreement, pay the one-time $5 registration fee.

### 2. The first upload, by hand

The API can only upload to an item that already exists, and only the dashboard can create one. So the first
version goes up by hand:

```sh
pnpm --filter @intentic/webext build
pnpm --filter @intentic/webext package     # → _computers/webext/dist.zip
```

In the dashboard: **Add new item**, upload `dist.zip`, then fill the listing from
[STORE-LISTING.md](STORE-LISTING.md) — name, summary, description, category, the permission justifications,
the data-usage answers, the privacy policy URL, the icon and at least one 1280×800 screenshot. Save as draft
and submit.

The URL now contains the item id: `.../devconsole/…/<32-lowercase-letters>/…`. That is
`CHROME_WEBSTORE_ITEM_ID`.

> Submit the first version to **trusted testers** if you would rather not have `cookies` reviewed in public.
> The dashboard offers it beside the publish button, and the workflow's `target` input matches.

### 3. API credentials (~15 minutes)

The Web Store API is an ordinary Google OAuth client. In <https://console.cloud.google.com>:

1. Create (or pick) a project, and enable **Chrome Web Store API**.
2. **APIs & Services → OAuth consent screen**: External, publishing status *Testing* is fine, and add the
   publisher account itself as a test user.
3. **Credentials → Create credentials → OAuth client ID → Desktop app**. Keep the client id and secret:
   `CHROME_WEBSTORE_CLIENT_ID`, `CHROME_WEBSTORE_CLIENT_SECRET`.
4. Get a refresh token for the publisher account. Open this in a browser signed in as that account, with your
   client id substituted:

   ```
   https://accounts.google.com/o/oauth2/auth?response_type=code&scope=https://www.googleapis.com/auth/chromewebstore&access_type=offline&prompt=consent&redirect_uri=urn:ietf:wg:oauth:2.0:oob&client_id=<CLIENT_ID>
   ```

   Approve, copy the code it shows, and exchange it once:

   ```sh
   curl -s https://oauth2.googleapis.com/token \
     -d client_id=<CLIENT_ID> -d client_secret=<CLIENT_SECRET> \
     -d code=<CODE> -d grant_type=authorization_code \
     -d redirect_uri=urn:ietf:wg:oauth:2.0:oob
   ```

   The `refresh_token` in the answer is `CHROME_WEBSTORE_REFRESH_TOKEN`. It does not expire while the client
   stays in *Testing* only if it is used at least every six months — a release every few weeks keeps it alive.
   Publishing the consent screen removes that caveat.

### 4. Tell the repository

**Settings → Secrets and variables → Actions**:

| Name | Kind | Value |
| --- | --- | --- |
| `CHROME_WEBSTORE_CLIENT_ID` | secret | from step 3 |
| `CHROME_WEBSTORE_CLIENT_SECRET` | secret | from step 3 |
| `CHROME_WEBSTORE_REFRESH_TOKEN` | secret | from step 3 |
| `CHROME_WEBSTORE_ITEM_ID` | **variable** | from step 2 — an extension id is public, and a secret would only make the logs unreadable |

### 5. Prove it

Actions ▸ **webstore publish** ▸ Run workflow, with the last release tag as the ref. It builds, packs and
uploads; the log ends in `submitted to default: ITEM_PENDING_REVIEW` (waiting on a reviewer) or
`OK` (live). A version already uploaded reports that and exits green.

From then on, nothing: every release dispatches it.

---

## What review will ask about

`cookies` is the permission that draws scrutiny, and the answer is in the listing already: it reads only the
current site's jar, only after a confirmation drawn on that page, only while a switch that is off by default is
on, and the data goes to a server the user paired themselves. If a reviewer refuses it anyway, shipping without
it is a two-line change — drop `"cookies"` from `static/manifest.json` and let `connect_site` refuse — and it
can come back as a later version once the listing has a track record.

Two things that make a first review slower, both avoidable: a minified bundle with no provenance (point the
review notes at this public repository and the commit), and a listing whose description promises anything the
permissions do not obviously serve.

## Still worth doing

- **Screenshots.** At least one, 1280×800, from a real session: the popup with a paired sandbox and two
  allowed sites, and a page mid-action with the banner up. The only listing asset that cannot come out of this
  repository.
- **Trim the background bundle.** 755 kB minified, ~200 kB of it the daemon's whole schema surface pulled in
  through the contract's barrel import. `@intentic/sandbox-contract/webext-links` already exists for the
  zero-dependency half (it took the content script from 1.1 MB to 374 bytes); the webext schemas want the same
  treatment.
- **Platform-brokered pairing.** Today's flow assumes the person has their sandbox open — true when they
  connect from the card, false when they arrive from the store listing, which is the funnel the listing will
  actually deliver.
- **Edge.** Same package, no code change, its own listing at <https://partner.microsoft.com/dashboard/microsoftedge>;
  the `edge` capability card already points at one. Automating it is one more script beside
  `publish-webstore.mjs`; the Edge API takes the same zip with a different auth dance.
