#!/usr/bin/env node
// Submits a release's Windows installer to the Microsoft Store, from msstore-publish.yml at the release tag —
// publish-webstore.mjs's shape for the other store this project ships to.
//
// THE STORE HOSTS NOTHING HERE. An EXE/MSI listing is a pointer: Partner Center keeps a package URL, downloads
// the binary from it to certify, and hands the same URL to every customer who installs. So a release publishes
// by pointing the listing's single package at the versioned GitHub Release asset the release already attached.
// Nothing is built and nothing is uploaded; the bytes Windows smoke-tested are the bytes the Store certifies.
//
// THE URL MUST BE THE VERSIONED ONE. Microsoft requires a versioned, immutable package URL and re-certifies
// (or pulls) a listing whose binary changes underneath it, so the site's /desktop/windows vanity path — which
// always resolves to the newest release — is the one URL that must never be submitted.
//
// MICROSOFT DOES NOT SIGN AN EXE/MSI SUBMISSION. An MSIX gets the Store's own certificate; an installer does
// not, and one without an Authenticode signature fails certification days later by email. That is checked here,
// against the downloaded asset, before anything is submitted.
//
// ONE SUBMISSION AT A TIME. Certification takes up to three business days and the API refuses to touch the
// draft while a submission is in flight, so a release cut during one leaves the Store where it is and says so:
// the next release carries it, or this workflow is dispatched again at that tag. Re-running is recovery — a run
// that staged the package but died before submitting finishes the job on the next attempt.
//
// Configuration, all five of which must be present or this skips loudly (secrets first, then repository
// variables): MSSTORE_TENANT_ID, MSSTORE_CLIENT_ID, MSSTORE_CLIENT_SECRET, MSSTORE_SELLER_ID,
// MSSTORE_PRODUCT_ID. docs/ops/microsoft-store.md is the one-time setup behind them.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repoRoot } from "../../constants/src/node.mjs";

const STORE_API = "https://api.store.microsoft.com";
/** The Store's cap on the "what's new" field. */
const WHATS_NEW_LIMIT = 1500;
/** How long the Store may take to fetch and scan the package before a submission can be created. */
const READY_TIMEOUT_MS = 20 * 60_000;
const POLL_INTERVAL_MS = 15_000;
/** Where a customer reads what an installer exit code meant; the Store shows it beside a failed install. */
const INSTALLER_DOC_URL = "https://intentic.dev/docs/troubleshooting/#installer-exit-codes";

// --- the decisions, which are the part worth testing (publish-msstore.test.mjs) ---------------------------------

/** A release version, or "" for anything that is not one: a branch ref reaches here as the name of the branch. */
export const releaseVersionOf = (ref) => {
    const version = (ref ?? "").replace(/^v/, "");
    return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : "";
};

/** Ordering by release number, negative when `left` is older. Non-numeric parts sort as 0, which is enough here. */
export const compareReleases = (left, right) => {
    const numbers = (value) => value.split(/[.-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : 0));
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

/** The release a package URL points at, read back out of the tag in its path, or "" when it points elsewhere. */
export const versionOfPackageUrl = (url) =>
    typeof url === "string" ? (url.match(/\/download\/v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\//)?.[1] ?? "") : "";

/**
 * What this run should do, from the Store's own state. `staged` is whether the draft already points at this
 * release's installer, `draftVersion` what it points at otherwise, `ongoing` the id of a submission in flight.
 *
 *   refuse  the draft is past this release: an old tag is being re-run over a newer one
 *   done    this release is the submission in flight
 *   defer   another release is in certification, so the draft cannot be touched at all
 *   submit  the draft already carries this release but nothing was submitted — finish the job
 *   stage   the ordinary case: replace the package, then submit
 */
export const nextAction = ({ version, staged, draftVersion = "", ongoing = "" }) => {
    if (draftVersion !== "" && compareReleases(draftVersion, version) > 0) {
        return "refuse";
    }
    if (ongoing !== "") {
        return staged ? "done" : "defer";
    }
    return staged ? "submit" : "stage";
};

/** The bullets under one `##` heading of a release body, up to the next heading of any level. */
export const bulletsUnder = (body, label) => {
    const heading = new RegExp(String.raw`^##\s+${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\s*$`, "i");
    const lines = (body ?? "").split(/\r?\n/);
    const start = lines.findIndex((line) => heading.test(line.trim()));
    if (start === -1) {
        return [];
    }
    const bullets = [];
    for (const line of lines.slice(start + 1)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("#")) {
            break;
        }
        if (trimmed.startsWith("- ")) {
            bullets.push(trimmed.slice(2).trim());
        }
    }
    return bullets.filter(Boolean);
};

/**
 * The listing's "what's new" for a release, from the same two headings publish-github.sh writes and the site,
 * the daemon and the Discord post read back (the release-headings check keeps the spellings in step). The link
 * is always last, so an overlong release loses bullets and never the way to read the rest.
 */
export const whatsNewFor = (body, notesUrl) => {
    const tail = `Full release notes: ${notesUrl}`;
    const bullets = [
        ...bulletsUnder(body, "Breaking changes").map((line) => `• Breaking: ${line}`),
        ...bulletsUnder(body, "What's new").map((line) => `• ${line}`),
    ];
    const kept = [];
    for (const bullet of bullets) {
        if ([...kept, bullet, tail].join("\n").length > WHATS_NEW_LIMIT) {
            break;
        }
        kept.push(bullet);
    }
    return [...kept, tail].join("\n");
};

/** The digest a SHA256SUMS file records for one artifact, or undefined when it names no such file. */
export const checksumFor = (sumsText, name) =>
    (sumsText ?? "")
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .find(([, recorded]) => recorded?.replace(/^\*/, "").replace(/^\.\//, "") === name)?.[0];

// --- the run ----------------------------------------------------------------------------------------------------

const json = async (response) => await response.json().catch(() => ({}));

/** Everything this run was told, or an exit: a usage error for a ref that is not a release, a loud skip for an
 * unconfigured listing. */
const configuration = () => {
    // A release, never a branch: dispatched at the tag, this reads the version off the ref the way the sibling
    // publish workflows do, and an explicit argument overrides it for a hand-run recovery.
    const ref = process.argv[2] ?? process.env["GITHUB_REF_NAME"];
    const version = releaseVersionOf(ref);
    if (version === "") {
        console.error(`error: "${ref ?? "(nothing)"}" is not a release version.`);
        console.error("usage: publish-msstore.mjs [version] — dispatch this workflow with a release TAG as the ref, or pass the version.");
        process.exit(1);
    }
    const credentials = {
        MSSTORE_TENANT_ID: process.env["MSSTORE_TENANT_ID"],
        MSSTORE_CLIENT_ID: process.env["MSSTORE_CLIENT_ID"],
        MSSTORE_CLIENT_SECRET: process.env["MSSTORE_CLIENT_SECRET"],
        MSSTORE_SELLER_ID: process.env["MSSTORE_SELLER_ID"],
        MSSTORE_PRODUCT_ID: process.env["MSSTORE_PRODUCT_ID"],
    };
    const missing = Object.entries(credentials)
        .filter(([, value]) => value === undefined || value === "")
        .map(([name]) => name);
    if (missing.length > 0) {
        console.log(`::warning title=Microsoft Store publish skipped::${missing.join(", ")} not set — the listing/API has not been configured yet.`);
        console.log("skipped: nothing was submitted. docs/ops/microsoft-store.md has the one-time setup.");
        process.exit(0);
    }
    const productId = credentials.MSSTORE_PRODUCT_ID;
    return {
        version,
        tag: `v${version}`,
        repo: process.env["GITHUB_REPOSITORY"] ?? "intentic/intentic",
        root: repoRoot(import.meta.url),
        tenantId: credentials.MSSTORE_TENANT_ID,
        clientId: credentials.MSSTORE_CLIENT_ID,
        clientSecret: credentials.MSSTORE_CLIENT_SECRET,
        sellerId: credentials.MSSTORE_SELLER_ID,
        product: `/submission/v1/product/${productId}`,
        dashboardUrl: `https://partner.microsoft.com/dashboard/products/${productId}/overview`,
    };
};

// What our installer is CALLED is decided in one place (desktop-artifacts.sh), and it is a shell file, so it is
// asked rather than re-spelled here. Arguments go in positionally: nothing is interpolated into a script.
const installerNameFor = (root, version) =>
    execFileSync(
        "sh",
        ["-c", '. "$1"; desktop_artifact_name "$2" "$3"', "artifact-name", join(root, "_tools/scripts/lib/desktop-artifacts.sh"), "nsis", version],
        {
            encoding: "utf8",
        },
    ).trim();

const releaseOf = async (repo, tag) => {
    const token = process.env["GITHUB_TOKEN"];
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
        headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
    });
    if (!response.ok) {
        throw new Error(`GitHub answered ${response.status} for the ${tag} release — is it released?`);
    }
    return await response.json();
};

/** The URL this submission hands the Store, and the checksum file that says what should be at it. */
const assetsOf = (release, { installerName, tag, version }) => {
    const assets = release.assets ?? [];
    const installer = assets.find((asset) => asset.name === installerName);
    if (installer === undefined) {
        throw new Error(`${tag} carries no ${installerName} — the package URL handed to the Store would 404 for every customer.`);
    }
    const sums = assets.find((asset) => asset.name === "SHA256SUMS");
    if (sums === undefined) {
        throw new Error(`${tag} carries no SHA256SUMS — the installer cannot be checked against what the release built.`);
    }
    const packageUrl = installer.browser_download_url;
    // The Store pins this URL forever, so it has to be the immutable per-release one, over https.
    if (!packageUrl.startsWith("https://") || versionOfPackageUrl(packageUrl) !== version) {
        throw new Error(`${packageUrl} is not this release's versioned https asset URL; the Store refuses a package URL whose bytes can change.`);
    }
    return { packageUrl, sumsUrl: sums.browser_download_url };
};

const accessTokenOf = async ({ tenantId, clientId, clientSecret }) => {
    const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: clientId,
            client_secret: clientSecret,
            scope: `${STORE_API}/.default`,
        }),
    });
    const body = await json(response);
    if (!response.ok || typeof body.access_token !== "string") {
        throw new Error(`Entra ID refused these credentials (${response.status}): ${body.error_description ?? body.error ?? "no reason given"}`);
    }
    return body.access_token;
};

// The API asks for a wait rather than failing, so a 429 is obeyed; treating it as an error would report the Store
// as broken when it only asked us to slow down.
const requestWithBackoff = async (accessToken, sellerId, method, path, body) => {
    for (let attempt = 0; ; attempt++) {
        const response = await fetch(`${STORE_API}${path}`, {
            method,
            headers: {
                authorization: `Bearer ${accessToken}`,
                "X-Seller-Account-Id": sellerId,
                ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (response.status !== 429 || attempt >= 5) {
            return response;
        }
        const wait = Number(response.headers.get("retry-after") ?? "10");
        console.log(`  rate limited on ${method} ${path}; waiting ${wait}s`);
        await new Promise((done) => setTimeout(done, (Number.isFinite(wait) ? wait : 10) * 1_000));
    }
};

/** A caller for the Store's API: every response is an {isSuccess, errors, responseData} envelope and a refusal can
 * arrive inside a 200, so the envelope decides, not the status code. Warnings ride in the same array. */
const storeCaller = (accessToken, sellerId) => async (method, path, body) => {
    const response = await requestWithBackoff(accessToken, sellerId, method, path, body);
    const envelope = await json(response);
    const errors = Array.isArray(envelope.errors) ? envelope.errors : [];
    const failures = errors.filter((error) => error?.code !== "warning");
    for (const warning of errors.filter((error) => error?.code === "warning")) {
        console.log(`::warning title=Microsoft Store::${warning.target ?? "submission"}: ${warning.message ?? "no detail"}`);
    }
    if (response.ok && envelope.isSuccess !== false && failures.length === 0) {
        return envelope.responseData ?? {};
    }
    const detail = failures.map((error) => `${error.target ?? "?"}: ${error.message ?? error.code ?? "no detail"}`).join("; ");
    const reason = detail === "" ? JSON.stringify(envelope) : detail;
    const refusal = new Error(`${method} ${path} refused (${response.status}): ${reason}`);
    refusal.reason = reason;
    throw refusal;
};

const draftStateOf = async (store, { product, packageUrl, version }) => {
    const draft = await store("GET", `${product}/packages`);
    const packages = draft.packages ?? [];
    const staged = packages.some((entry) => entry?.packageUrl === packageUrl);
    const draftVersion = versionOfPackageUrl(packages[0]?.packageUrl);
    const status = await store("GET", `${product}/status`);
    const ongoing = status.ongoingSubmissionId ?? "";
    return { action: nextAction({ version, staged, draftVersion, ongoing }), draftVersion, ongoing, isReady: status.isReady === true };
};

/** Whether the run stops here, having said why. Exits rather than returning for the two states that are not
 * failures: this release is the one in certification, or another one is. */
const settled = ({ action, draftVersion, ongoing }, { version, tag, dashboardUrl }) => {
    if (action === "refuse") {
        throw new Error(`the Store's draft already carries ${draftVersion}, which is newer than ${version}: refusing to rerun an old release.`);
    }
    if (action === "done") {
        console.log(`${version} is already submitted (submission ${ongoing}); certification is in progress. Nothing to do.`);
        process.exit(0);
    }
    if (action !== "defer") {
        return;
    }
    // Expected, not broken: the API cannot touch a draft under certification, and certification is measured in
    // days while releases are measured in hours.
    const held = draftVersion === "" ? "an earlier release" : draftVersion;
    console.log(
        `::warning title=Microsoft Store publish deferred::submission ${ongoing} (${held}) is still in certification, so the draft cannot be updated. ` +
            `${version} was NOT submitted — the next release carries it, or dispatch this workflow again at ${tag} once certification finishes.`,
    );
    console.log(`deferred: the Store stays on ${held}. ${dashboardUrl}`);
    process.exit(0);
};

const download = async (url, into, name) => {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) {
        throw new Error(`${url} answered ${response.status} — the Store downloads this URL to certify, so it must be publicly fetchable.`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const path = join(into, name);
    writeFileSync(path, bytes);
    return { path, bytes };
};

/** Downloads rather than trusts, because the submission is a claim about these exact bytes: that they are the ones
 * the release attested, and that they carry a signature Windows will accept. */
const verifyInstaller = async ({ packageUrl, sumsUrl, installerName, root }) => {
    const work = mkdtempSync(join(tmpdir(), "msstore-"));
    try {
        const { path, bytes } = await download(packageUrl, work, installerName);
        const expected = checksumFor((await download(sumsUrl, work, "SHA256SUMS")).bytes.toString("utf8"), installerName);
        if (expected === undefined) {
            throw new Error(`SHA256SUMS names no ${installerName}; the release set and this submission disagree about what was built.`);
        }
        const actual = createHash("sha256").update(bytes).digest("hex");
        if (actual !== expected) {
            throw new Error(
                `${packageUrl} serves ${actual}, but the release recorded ${expected}. Not submitting a binary the release did not build.`,
            );
        }
        // Authenticode, read off the PE itself. The Store signs MSIX packages and only MSIX packages: an unsigned
        // installer is a certification refusal that arrives days after this run went green.
        try {
            execFileSync("bash", [join(root, "_tools/scripts/build/sign-windows.sh"), "--check", path], { stdio: "pipe" });
        } catch {
            console.error(
                `error: ${installerName} carries no Authenticode signature, and Microsoft does not sign EXE/MSI submissions — certification would refuse it.`,
            );
            console.error(
                "Set the WINDOWS_SIGN_* secrets and cut a release that signs (docs/ops/windows-code-signing.md), then dispatch this workflow at that tag.",
            );
            process.exit(1);
        }
        console.log(`${installerName}: ${(bytes.length / 1024 / 1024).toFixed(1)} MB, sha256 matches the release, Authenticode present.`);
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
};

/** Non-fatal on purpose, and loud: current copy is worth having, but a release reaches users through the package,
 * and a note nobody could write is no reason to leave them on the old installer. A patch touches only what it
 * names. */
const updateWhatsNew = async (store, { product, version, whatsNew }) => {
    try {
        await store("PATCH", `${product}/metadata`, { listings: { language: "en-us", whatsNew } });
        console.log(`what's new: ${whatsNew.split("\n").length - 1} bullet(s) + the release notes link.`);
    } catch (error) {
        console.log(
            `::warning title=Microsoft Store listing not updated::the "what's new" text for ${version} was refused (${error.reason ?? error.message}); ` +
                "the package is unaffected.",
        );
    }
};

// What the Store needs to know about an EXE it did not build: how to run it without a UI, what its exit codes
// mean, and where a customer reads about them. A full module update replaces the package set, which is what a
// single-installer listing wants: one package, this release's, with no predecessor left for anybody to install.
const stagePackage = async (store, { product, packageUrl }) => {
    await store("PUT", `${product}/packages`, {
        packages: [
            {
                packageUrl,
                languages: ["en-us"],
                architectures: ["X64"],
                // NSIS is silent only when told to be, so the switch is declared rather than assumed; the Store
                // installs with it and certification fails on a window it did not expect.
                isSilentInstall: false,
                installerParameters: "/S",
                genericDocUrl: INSTALLER_DOC_URL,
                // NSIS's own exit codes, which is all an installer this thin can return.
                errorDetails: [
                    { errorScenario: "installationCancelledByUser", errorScenarioDetails: [{ errorValue: "1", errorUrl: INSTALLER_DOC_URL }] },
                    { errorScenario: "miscellaneous", errorScenarioDetails: [{ errorValue: "2", errorUrl: INSTALLER_DOC_URL }] },
                ],
                packageType: "exe",
            },
        ],
    });
    await store("POST", `${product}/packages/commit`);
    console.log(`staged ${packageUrl}`);
};

/** The Store fetches and scans the package before a submission may be created, and refuses one while any module is
 * still working. A timeout leaves the draft staged, so the recovery is to run this again. */
const waitUntilReady = async (store, ready, { product, installerName, version, tag, dashboardUrl }) => {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (!ready) {
        if (Date.now() > deadline) {
            console.error(
                `error: the Store was still processing ${installerName} after ${READY_TIMEOUT_MS / 60_000} minutes, so no submission was created.`,
            );
            console.error(`The draft is staged at ${version}: dispatch this workflow again at ${tag} to finish, or submit from ${dashboardUrl}.`);
            process.exit(1);
        }
        await new Promise((done) => setTimeout(done, POLL_INTERVAL_MS));
        const polled = await store("GET", `${product}/status`);
        // A submission appearing while the package is being scanned is this run's package under certification,
        // unless somebody submitted from the dashboard at the same moment — either way there is now one in
        // flight, and a second cannot be created.
        if ((polled.ongoingSubmissionId ?? "") !== "") {
            console.log(`submission ${polled.ongoingSubmissionId} is in certification; ${version} is staged and needs nothing further here.`);
            process.exit(0);
        }
        ready = polled.isReady === true;
    }
};

/** The created submission, or an exit on the one refusal that means "already done": something created it between
 * the state read and this call, and a second one is neither possible nor wanted. */
const createSubmission = async (store, { product, version }) => {
    try {
        return await store("POST", `${product}/submit`);
    } catch (error) {
        const reason = error.reason ?? error.message;
        if (!/active submission|in progress|already/i.test(reason)) {
            throw error;
        }
        console.log(`${version} is already submitted: ${reason}`);
        process.exit(0);
    }
};

const submitDraft = async (store, { product, version, dashboardUrl }) => {
    const submission = await createSubmission(store, { product, version });
    const submissionId = submission.submissionId ?? "";
    const pollingUrl = submission.pollingUrl ?? "";
    console.log(`submitted ${version} to the Microsoft Store: submission ${submissionId}.`);
    const status = await store("GET", pollingUrl === "" ? `${product}/submission/${submissionId}/status` : pollingUrl);
    if (status.hasFailed === true) {
        throw new Error(
            `the Store reports submission ${submissionId} as failed (${status.publishingStatus ?? "no status"}); ${dashboardUrl} has the detail.`,
        );
    }
    console.log(`publishing status: ${status.publishingStatus ?? "INPROGRESS"} — certification takes up to three business days. ${dashboardUrl}`);
};

const main = async () => {
    const run = configuration();
    const installerName = installerNameFor(run.root, run.version);
    const release = await releaseOf(run.repo, run.tag);
    const { packageUrl, sumsUrl } = assetsOf(release, { installerName, tag: run.tag, version: run.version });

    const store = storeCaller(await accessTokenOf(run), run.sellerId);
    const state = await draftStateOf(store, { product: run.product, packageUrl, version: run.version });
    settled(state, run);

    await verifyInstaller({ packageUrl, sumsUrl, installerName, root: run.root });
    await updateWhatsNew(store, {
        ...run,
        whatsNew: whatsNewFor(release.body, release.html_url ?? `https://github.com/${run.repo}/releases/tag/${run.tag}`),
    });
    if (state.action === "stage") {
        await stagePackage(store, { product: run.product, packageUrl });
    } else {
        console.log(`the draft already points at ${run.version}; continuing to submission.`);
    }
    await waitUntilReady(store, state.action === "submit" && state.isReady, { ...run, installerName });
    await submitDraft(store, run);
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) {
    await main();
}
