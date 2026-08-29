import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/* Upload the built extension and submit it through Chrome Web Store API V2.
 *
 * Runs from webstore-publish.yml at the release tag, after set-versions.sh, build and package:
 *
 *   1. exchange the publisher's refresh token for a short-lived access token;
 *   2. inspect the published and submitted revisions (the idempotency check);
 *   3. upload dist.zip, polling when Google processes it asynchronously;
 *   4. submit the draft for review and require an affirmative item state.
 *
 * V2, NOT V1. V1 disappears on 15 October 2026 and its HTTP-200 response carried failures in a separate
 * status list. V2 has durable resource states, a publisher id in every path, and one fetchStatus call that can
 * distinguish "already published", "under review" and "uploaded but not submitted".
 *
 * A RE-RUN IS RECOVERY, not merely a no-op. If upload landed and the publish request or runner then died, the
 * next run sees no submitted revision, tolerates ALREADY_EXISTS from upload, and calls publish again. If the
 * version is already submitted or live it exits green before uploading. That closes the gap where the old
 * script called an uploaded draft "nothing to do" and left it stranded forever.
 *
 * Distribution is dashboard state in V2. Public, unlisted and trusted-testers visibility is configured there;
 * the API submits to the item's current channel and cannot silently widen it.
 *
 *   node _tools/scripts/publish-webstore.mjs 1.209.1
 */

const version = process.argv[2];
if (version === undefined) {
    console.error("usage: publish-webstore.mjs <version>");
    process.exit(1);
}

const clientId = process.env["CHROME_WEBSTORE_CLIENT_ID"];
const clientSecret = process.env["CHROME_WEBSTORE_CLIENT_SECRET"];
const refreshToken = process.env["CHROME_WEBSTORE_REFRESH_TOKEN"];
const publisherId = process.env["CHROME_WEBSTORE_PUBLISHER_ID"];
const itemId = process.env["CHROME_WEBSTORE_ITEM_ID"];

const missing = Object.entries({
    CHROME_WEBSTORE_CLIENT_ID: clientId,
    CHROME_WEBSTORE_CLIENT_SECRET: clientSecret,
    CHROME_WEBSTORE_REFRESH_TOKEN: refreshToken,
    CHROME_WEBSTORE_PUBLISHER_ID: publisherId,
    CHROME_WEBSTORE_ITEM_ID: itemId,
})
    .filter(([, value]) => value === undefined || value === "")
    .map(([name]) => name);
if (missing.length > 0) {
    console.log(`::warning title=Chrome Web Store publish skipped::${missing.join(", ")} not set — the listing/API has not been configured yet.`);
    console.log("skipped: nothing was uploaded. _computers/webext/PUBLISHING.md has the one-time setup.");
    process.exit(0);
}

const webext = fileURLToPath(new URL("../../_computers/webext/", import.meta.url));
const packedVersion = JSON.parse(readFileSync(join(webext, "dist", "manifest.json"), "utf8")).version;
if (packedVersion !== version) {
    console.error(`error: the built manifest says ${packedVersion}, not ${version} — this tree was not stamped for this release.`);
    process.exit(1);
}
const bytes = readFileSync(join(webext, "dist.zip"));

const json = async (response) => await response.json().catch(() => ({}));
const detail = (body) => body?.error?.message ?? body?.message ?? JSON.stringify(body);

const accessToken = async () => {
    const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
    });
    const body = await json(response);
    if (!response.ok || typeof body.access_token !== "string") {
        throw new Error(`the store refused these credentials (${response.status}): ${body.error_description ?? body.error ?? "no reason given"}`);
    }
    return body.access_token;
};

const authorization = { authorization: `Bearer ${await accessToken()}` };
const escapedPublisher = encodeURIComponent(publisherId);
const escapedItem = encodeURIComponent(itemId);
const item = `publishers/${escapedPublisher}/items/${escapedItem}`;
const api = `https://chromewebstore.googleapis.com/v2/${item}`;

const fetchStatus = async () => {
    const response = await fetch(`${api}:fetchStatus`, { headers: authorization });
    const body = await json(response);
    if (!response.ok) {
        throw new Error(`could not read Web Store status (${response.status}): ${detail(body)}`);
    }
    if (body.takenDown === true) {
        throw new Error(`item ${itemId} has been taken down; the dashboard must be resolved before another version can publish.`);
    }
    return body;
};

const revisionHasVersion = (revision) =>
    Array.isArray(revision?.distributionChannels) && revision.distributionChannels.some((channel) => channel?.crxVersion === version);

const revisionVersions = (revision) =>
    Array.isArray(revision?.distributionChannels)
        ? [...new Set(revision.distributionChannels.map((channel) => channel?.crxVersion).filter((value) => typeof value === "string"))]
        : [];

const compareVersions = (left, right) => {
    const numbers = (value) => value.split(".").map(Number);
    const leftParts = numbers(left);
    const rightParts = numbers(right);
    for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
        const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
        if (difference !== 0) {
            return difference;
        }
    }
    return 0;
};

const settledRevision = (status) => {
    if (revisionHasVersion(status.publishedItemRevisionStatus)) {
        return { where: "published", state: status.publishedItemRevisionStatus.state };
    }
    if (revisionHasVersion(status.submittedItemRevisionStatus)) {
        return { where: "submitted", state: status.submittedItemRevisionStatus.state };
    }
    return undefined;
};

const SUCCESS_STATES = new Set(["PENDING_REVIEW", "STAGED", "PUBLISHED", "PUBLISHED_TO_TESTERS"]);
const finishIfSettled = (status) => {
    const revision = settledRevision(status);
    if (revision === undefined) {
        return false;
    }
    if (!SUCCESS_STATES.has(revision.state)) {
        throw new Error(`${version} is the ${revision.where} revision but the store reports ${revision.state}; inspect the developer dashboard.`);
    }
    console.log(`${version} is already ${revision.where}: ${revision.state}.`);
    return true;
};

/* A duplicate upload is only evidence of a recoverable draft when this release is newer than everything
 * currently live and no different revision is already submitted. Without these checks, rerunning an OLD tag
 * could receive ALREADY_EXISTS for its historical version and then submit an unrelated draft from the
 * dashboard. Likewise, a release must never trample a different version that is already under review. */
const assertReleaseCanProceed = (status) => {
    const submitted = revisionVersions(status.submittedItemRevisionStatus);
    if (submitted.length > 0 && !submitted.includes(version)) {
        throw new Error(
            `the store already has ${submitted.join(", ")} submitted (${status.submittedItemRevisionStatus.state}); refusing to replace it with ${version}.`,
        );
    }
    const newerPublished = revisionVersions(status.publishedItemRevisionStatus).filter((published) => compareVersions(published, version) > 0);
    if (newerPublished.length > 0) {
        throw new Error(`the store already publishes newer version ${newerPublished.join(", ")}; refusing to rerun old release ${version}.`);
    }
};

const initialStatus = await fetchStatus();
if (finishIfSettled(initialStatus)) {
    process.exit(0);
}
assertReleaseCanProceed(initialStatus);

const upload = await fetch(`https://chromewebstore.googleapis.com/upload/v2/${item}:upload`, {
    method: "POST",
    headers: { ...authorization, "content-type": "application/zip" },
    body: bytes,
});
const uploaded = await json(upload);
if (!upload.ok) {
    // An upload can have committed even when the runner never received its successful response. V2 reports a
    // second attempt as ALREADY_EXISTS; that means "publish the draft", not "the release is complete".
    const duplicate = uploaded?.error?.status === "ALREADY_EXISTS" || /already (?:exists|uploaded)/i.test(detail(uploaded));
    if (!duplicate) {
        throw new Error(`upload refused (${upload.status}): ${detail(uploaded)}`);
    }
    const status = await fetchStatus();
    if (finishIfSettled(status)) {
        process.exit(0);
    }
    assertReleaseCanProceed(status);
    console.log(`${version} is already the uploaded draft; continuing to submission.`);
} else if (uploaded.uploadState === "SUCCEEDED") {
    if (uploaded.crxVersion !== version) {
        throw new Error(`upload answered with version ${uploaded.crxVersion ?? "(none)"}, expected ${version}.`);
    }
    console.log(`uploaded ${version} (${bytes.length} bytes) to item ${itemId}.`);
} else if (uploaded.uploadState === "IN_PROGRESS") {
    console.log(`uploaded ${version} (${bytes.length} bytes); the store is still processing it.`);
    let state = "IN_PROGRESS";
    for (let attempt = 0; attempt < 60 && state === "IN_PROGRESS"; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        state = (await fetchStatus()).lastAsyncUploadState ?? "IN_PROGRESS";
    }
    if (state !== "SUCCEEDED") {
        throw new Error(`upload processing ended in ${state} rather than SUCCEEDED.`);
    }
    console.log(`the store finished processing ${version}.`);
} else {
    throw new Error(`upload returned ${uploaded.uploadState ?? "no state"}: ${detail(uploaded)}`);
}

const publish = await fetch(`${api}:publish`, {
    method: "POST",
    headers: { ...authorization, "content-type": "application/json" },
    body: JSON.stringify({ publishType: "DEFAULT_PUBLISH", blockOnWarnings: false }),
});
const published = await json(publish);
if (!publish.ok) {
    // If the server committed before the response was lost, status is authoritative and makes the run green.
    if (finishIfSettled(await fetchStatus())) {
        process.exit(0);
    }
    throw new Error(`publish failed (${publish.status}): ${detail(published)}`);
}
if (!SUCCESS_STATES.has(published.state)) {
    throw new Error(`publish returned HTTP ${publish.status} but no success state: ${published.state ?? detail(published)}`);
}
console.log(`submitted ${version}: ${published.state}.`);
for (const warning of published.warningInfo?.warnings ?? []) {
    console.log(`::warning title=Chrome Web Store warning::${warning.reason ?? "warning"}: ${warning.description ?? "no detail"}`);
}
