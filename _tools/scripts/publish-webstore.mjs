import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/* Upload the built browser extension to the Chrome Web Store and submit it, at the version the release cut.
 *
 * Runs from .github/workflows/webstore-publish.yml, on the `v*` tag semantic-release pushed, after the
 * extension is built and packed. The store's API is three plain HTTP calls and needs no SDK:
 *
 *   1. POST oauth2.googleapis.com/token                  refresh token → a short-lived access token
 *   2. PUT  .../upload/chromewebstore/v1.1/items/<id>    the zip; answers with an upload state
 *   3. POST .../chromewebstore/v1.1/items/<id>/publish   submits that draft for review
 *
 * INERT UNTIL THE CREDENTIALS EXIST, and it SKIPS rather than fails — publish-action.sh's rule, for the same
 * reason. The listing is created by hand once (the developer account, the agreement, the categories and the
 * screenshots exist only in the UI), and until that has happened there is no item id to upload to. A red
 * release train over an artifact that is not yet listed teaches everyone to ignore red; a loud skip does not.
 *
 * A RE-RUN IS SAFE BUT NOT SILENT. The store refuses an upload whose version already exists, so a second run
 * over the same release reports that refusal and exits 0 — the "already up" reading publish-npm.sh takes.
 *
 * PUBLISHING IS NOT SHIPPING. Step 3 submits the version for review; Google decides when it goes live, which
 * is days for a first submission and hours afterwards. `target` is the audience: `default` is everyone,
 * `trustedTesters` is the tester list on the listing — which is what the first releases should use, while the
 * reviewers are still deciding how they feel about a `cookies` permission.
 *
 *   node _tools/scripts/publish-webstore.mjs 1.209.1 [default|trustedTesters]
 */

const version = process.argv[2];
const target = process.argv[3] ?? "default";
if (version === undefined) {
    console.error("usage: publish-webstore.mjs <version> [default|trustedTesters]");
    process.exit(1);
}
if (target !== "default" && target !== "trustedTesters") {
    console.error(`unknown publish target "${target}": it is "default" (everyone) or "trustedTesters".`);
    process.exit(1);
}

const clientId = process.env["CHROME_WEBSTORE_CLIENT_ID"];
const clientSecret = process.env["CHROME_WEBSTORE_CLIENT_SECRET"];
const refreshToken = process.env["CHROME_WEBSTORE_REFRESH_TOKEN"];
const itemId = process.env["CHROME_WEBSTORE_ITEM_ID"];

// The skip. Loud, and specific about WHICH of the four is missing, because "it did nothing" is the failure
// this whole shape exists to make impossible to misread.
const missing = Object.entries({
    CHROME_WEBSTORE_CLIENT_ID: clientId,
    CHROME_WEBSTORE_CLIENT_SECRET: clientSecret,
    CHROME_WEBSTORE_REFRESH_TOKEN: refreshToken,
    CHROME_WEBSTORE_ITEM_ID: itemId,
})
    .filter(([, value]) => value === undefined || value === "")
    .map(([name]) => name);
if (missing.length > 0) {
    // An Actions annotation, so a skipped publish is visible on the run rather than only in its log.
    console.log(`::warning title=Chrome Web Store publish skipped::${missing.join(", ")} not set — the listing has not been created yet.`);
    console.log("skipped: nothing was uploaded. _computers/webext/PUBLISHING.md has the one-time setup.");
    process.exit(0);
}

const webext = fileURLToPath(new URL("../../_computers/webext/", import.meta.url));

/* THE VERSION IS READ BACK OFF THE BUILT ARTIFACT rather than trusted from the argument. The manifest's number
 * is what the store records and what an installed browser then reports, and it is DERIVED from the package
 * version by a build step (scripts/stamp-manifest.mjs) — so a job that packed before it stamped, or stamped an
 * unstamped tree, would upload a release under the wrong number and nobody would find out until somebody tried
 * to install "the" version and got 0.0.0. */
const packedVersion = JSON.parse(readFileSync(join(webext, "dist", "manifest.json"), "utf8")).version;
if (packedVersion !== version) {
    console.error(`error: the built manifest says ${packedVersion}, not ${version} — this tree was not stamped for this release.`);
    process.exit(1);
}
const bytes = readFileSync(join(webext, "dist.zip"));

const accessToken = async () => {
    const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.access_token !== "string") {
        // Google's own words. `invalid_grant` here almost always means the refresh token was minted against a
        // different OAuth client, or the account revoked it, and saying that beats a bare 400.
        throw new Error(`the store refused these credentials (${response.status}): ${body.error_description ?? body.error ?? "no reason given"}`);
    }
    return body.access_token;
};

const headers = { authorization: `Bearer ${await accessToken()}`, "x-goog-api-version": "2" };

const upload = await fetch(`https://www.googleapis.com/upload/chromewebstore/v1.1/items/${itemId}`, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/zip" },
    body: bytes,
});
const uploaded = await upload.json().catch(() => ({}));
const detail = (uploaded.itemError ?? []).map((error) => error.error_detail ?? "").join("; ");
if (uploaded.uploadState === "FAILURE" || !upload.ok) {
    // A version already up is the ordinary outcome of a re-run, and not a failure of this run.
    if (/already exists/i.test(detail)) {
        console.log(`${version} is already uploaded to item ${itemId}: nothing to do.`);
        process.exit(0);
    }
    throw new Error(`upload refused (${upload.status}): ${detail || JSON.stringify(uploaded)}`);
}
console.log(`uploaded ${version} (${bytes.length} bytes) to item ${itemId}: ${uploaded.uploadState ?? "(no state)"}`);

// `publishTarget` rides the query string: the header form the older docs showed is silently ignored by the
// current API, which would publish a "testers only" release to everyone.
const publish = await fetch(`https://www.googleapis.com/chromewebstore/v1.1/items/${itemId}/publish?publishTarget=${target}`, {
    method: "POST",
    headers: { ...headers, "content-length": "0" },
});
const published = await publish.json().catch(() => ({}));
if (!publish.ok) {
    throw new Error(`publish failed (${publish.status}): ${(published.statusDetail ?? []).join("; ") || JSON.stringify(published)}`);
}
/* The store answers with a status LIST rather than a verdict, and the distinction in it matters: `OK` means it
 * went live, `ITEM_PENDING_REVIEW` means submitted and waiting on a human. Both are printed verbatim, so a
 * release's log says which happened instead of claiming "published" for both. */
console.log(`submitted to ${target}: ${(published.status ?? ["(no status)"]).join(", ")}`);
for (const line of published.statusDetail ?? []) {
    console.log(`  ${line}`);
}
