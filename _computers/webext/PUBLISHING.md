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
| Icons, rendered from the shared lotus in `_site/site/src/components/ornaments.ts` | `scripts/render-icons.mjs` → `static/icons/` |
| Required 440×280 promotional tile, from the same lotus | `scripts/render-store-assets.mjs` → `assets/store/` |
| V2 upload + status polling + retry-safe submit | `_tools/scripts/publish-webstore.mjs` |
| Runs on every release | `.github/workflows/webstore-publish.yml`, listed in `_tools/scripts/dispatch-publish.sh` |
| Listing copy, field by field | [STORE-LISTING.md](STORE-LISTING.md) |
| Privacy policy the listing must link | `_site/site-content/src/legal.ts`, section *The browser extension* |
| The page the listing links to | `_site/site/src/pages/docs/your-browser.astro` |

**The release version is not in the tree.** Every first-party `package.json` here stays at `0.0.0` and CI
stamps the release version onto it. Chrome forbids an all-zero manifest version, so an unstamped build maps
that workspace sentinel to **`0.0.0.1`** — a valid development version and the deliberately low first manual
upload. A tagged build derives its real number from the stamped package. After the listing exists, never
publish another hand-built zip: the store requires each uploaded version to be strictly newer.

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

This build contains manifest version `0.0.0.1`, intentionally lower than every semantic-release version. In
the dashboard: **Add new item**, upload `dist.zip`, then fill the listing from
[STORE-LISTING.md](STORE-LISTING.md) — name, summary, description, category, the permission justifications,
the data-usage answers, the privacy policy URL, the icon, the required 440×280 promotional tile and at least
one 1280×800 screenshot. Save as draft and submit.

The URL now contains the item id: `.../devconsole/…/<32-lowercase-letters>/…`. That is
`CHROME_WEBSTORE_ITEM_ID`. Under **Publisher → Settings**, copy the publisher id too; that is
`CHROME_WEBSTORE_PUBLISHER_ID`, required by every V2 API path.

> Submit the first version to **trusted testers** if you want a limited audience while the item is new. API V2
> preserves the visibility configured in the dashboard; it cannot change a testers-only item to public. If you
> later change visibility, Chrome requires one manual dashboard publish before the API can use the new setting.

### 3. API credentials (~15 minutes)

The Web Store API is an ordinary Google OAuth client. In <https://console.cloud.google.com>:

1. Create (or pick) a project, and enable **Chrome Web Store API**.
2. **APIs & Services → OAuth consent screen**: choose External and fill the required app/contact fields. Move
   its publishing status to **In production before minting the CI token**. External apps left in Testing issue
   refresh tokens that expire after seven days, regardless of use, which is not an automation credential.
3. **Credentials → Create credentials → OAuth client ID → Web application**. Add
   `https://developers.google.com/oauthplayground` as an authorised redirect URI. Keep the client id and secret
   as `CHROME_WEBSTORE_CLIENT_ID` and `CHROME_WEBSTORE_CLIENT_SECRET`.
4. Open <https://developers.google.com/oauthplayground> while signed in as the account that owns the Web Store
   item. Open its settings, enable **Use your own OAuth credentials**, and enter that client id and secret.
5. In **Input your own scopes**, enter `https://www.googleapis.com/auth/chromewebstore`, press **Authorize
   APIs**, approve it, then press **Exchange authorization code for tokens**. The returned `refresh_token` is
   `CHROME_WEBSTORE_REFRESH_TOKEN`.

The API is for the publisher managing its own item. An unverified OAuth app warning does not stop this use,
but the account authorising the token must own the Chrome Web Store item.

### 4. Tell the repository

**Settings → Secrets and variables → Actions**:

| Name | Kind | Value |
| --- | --- | --- |
| `CHROME_WEBSTORE_CLIENT_ID` | secret | from step 3 |
| `CHROME_WEBSTORE_CLIENT_SECRET` | secret | from step 3 |
| `CHROME_WEBSTORE_REFRESH_TOKEN` | secret | from the OAuth Playground exchange |
| `CHROME_WEBSTORE_PUBLISHER_ID` | **variable** | Publisher → Settings in the Web Store dashboard |
| `CHROME_WEBSTORE_ITEM_ID` | **variable** | from step 2 — an extension id is public, and a secret would only make the logs unreadable |

### 5. Prove it

Actions ▸ **webstore publish** ▸ Run workflow, with the last release tag as the ref. It builds, packs and
uploads; the log ends in `submitted <version>: PENDING_REVIEW`, `PUBLISHED_TO_TESTERS` or `PUBLISHED`. A version
already submitted or live exits green. A version whose upload landed before a failed publish is submitted on
the retry rather than mistaken for complete.

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

- **A second screenshot.** The first one is committed (`assets/store/popup-1280x800.png`) and regenerates from
  the repository — `pnpm --filter @intentic/webext preview` renders the real popup at exactly 1280×800. What it
  cannot show is the other half of the product: a real page mid-action with the banner up. That one needs a
  live session, and it is the shot that sells this.
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
