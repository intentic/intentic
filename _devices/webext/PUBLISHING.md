# Publishing to the Chrome Web Store

Every release tag builds the extension and submits it to the Chrome Web Store from CI, once the listing and its API credentials are set up by hand.

## One-time setup

1. Build and pack a first copy: `pnpm turbo run build --filter=./_devices/webext && pnpm --filter @intentic/webext package`.
   An unstamped build carries version `0.0.0.1`.
2. In the Chrome Web Store developer dashboard, create the item by uploading that `dist.zip`, fill in the listing from
   [STORE-LISTING.md](STORE-LISTING.md), and pick the audience (public, unlisted or trusted testers). The API keeps
   the audience and cannot widen it.
3. In a Google Cloud project, enable the Chrome Web Store API, create an OAuth client, and mint a refresh token for
   the publisher account with it.
4. In the GitHub repository, add the secrets `CHROME_WEBSTORE_CLIENT_ID`, `CHROME_WEBSTORE_CLIENT_SECRET` and
   `CHROME_WEBSTORE_REFRESH_TOKEN`, and the variables `CHROME_WEBSTORE_PUBLISHER_ID` and `CHROME_WEBSTORE_ITEM_ID`
   from the dashboard. Until all five exist, the publish step logs a warning and skips.

Before releasing a version that adds a manifest permission, update the item's **Privacy practices** tab in the
Developer Dashboard with the matching justification from [STORE-LISTING.md](STORE-LISTING.md). The listing half is
enforced: [`src/store-listing.test.ts`](src/store-listing.test.ts) fails a commit that adds a permission, a host pattern or
a content script's sites without a row there (an optional one marked `(optional)`). The dashboard half is still a person's
step: the store's API does not set it. Passwords adds
**optional** `nativeMessaging` and uses the existing optional host permission for `*://*/*` when the person
turns remembering on; justify them as:

- **nativeMessaging:** Talks only to the Intentic desktop app's local native host so passwords the person saves in
  this browser are sealed on their own computer and filled only after they confirm there (Windows Hello / system
  consent). No other native hosts, no remote servers.
- **Host permission (all sites, optional):** Used only after an explicit "Turn on" for Passwords, to inject capture
  and fill UI on pages where the person signs in. Separate from the agent's per-site grants; does not widen what
  the sandbox may read or click.

User scripts add the **optional** `userScripts` permission, requested only when the person presses "Turn on scripts"
in the popup; justify it as:

- **userScripts (optional):** Runs user scripts that the user reviews and installs from the extension's popup, to
  change sites they have allowed. Requested only when the user turns scripts on. Each script's full code, the sites
  it runs on and the hosts it may reach are shown to the user before it is installed, and nothing runs without their
  click. It uses Chrome's documented User Scripts API, which the Manifest V3 remote-code policy names as a permitted
  way to run code that is not in the extension package.

Downloads add the **optional** `downloads` permission, requested only when the person turns Downloads on in the
popup; justify it as:

- **downloads (optional):** Moves a file that the agent's own click downloaded (for example, a site's Download
  button in the agent's window) into the user's own sandbox, where the agent can use it, and then removes it from the
  browser's download list. Requested only when the user turns Downloads on. Downloads the user starts are not read
  beyond their address and are never moved. Files go only to the user's own sandbox.

Uploading the package through the API does not fill those fields. The store can accept the upload and then reject
`:publish` with HTTP 400, "Your submission does not meet the requirements to be published in the store." The API
response does not name the missing field. Open the item in the Developer Dashboard and select **Why can't I submit?**
beside **Submit for review** to see the exact validation errors. Fill the missing fields and select **Save draft**;
the submit button becomes enabled when the requirements are met. Optional permissions require justifications too:
the missing `nativeMessaging` justification blocked release `1.353.0` despite a successful upload, and the missing `downloads` one blocked `1.413.0`.

After correcting dashboard metadata, rerun the failed publish job at the same release tag. The uploaded package
does not need a new version just to submit its corrected listing.

## Each release

1. `release.yml` runs `dispatch-publish.sh`, which starts
   [webstore-publish.yml](../../.github/workflows/webstore-publish.yml) at the new tag.
2. The workflow stamps the tag's version into the tree (`set-versions.sh`), builds the extension, whose
   `scripts/stamp-manifest.mjs` writes that version into `dist/manifest.json`, and packs `dist.zip`.
3. [publish-webstore.mjs](../../_tools/scripts/release/publish-webstore.mjs) checks the packed version matches the
   tag, uploads the zip, waits while the store processes it, and submits it for review.
4. To retry, run the workflow by hand: Actions ▸ webstore publish ▸ Run workflow, with the tag as the ref. A re-run
   picks up a draft already uploaded or a revision already submitted, and refuses when the store holds a newer version.
