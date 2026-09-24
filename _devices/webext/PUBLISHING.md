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

## Each release

1. `release.yml` runs `dispatch-publish.sh`, which starts
   [webstore-publish.yml](../../.github/workflows/webstore-publish.yml) at the new tag.
2. The workflow stamps the tag's version into the tree (`set-versions.sh`), builds the extension, whose
   `scripts/stamp-manifest.mjs` writes that version into `dist/manifest.json`, and packs `dist.zip`.
3. [publish-webstore.mjs](../../_tools/scripts/release/publish-webstore.mjs) checks the packed version matches the
   tag, uploads the zip, waits while the store processes it, and submits it for review.
4. To retry, run the workflow by hand: Actions ▸ webstore publish ▸ Run workflow, with the tag as the ref. A re-run
   picks up a draft already uploaded or a revision already submitted, and refuses when the store holds a newer version.
