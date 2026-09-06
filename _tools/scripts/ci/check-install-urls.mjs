#!/usr/bin/env node
/* THE ONE-LINERS THIS PRODUCT HANDS OUT, FETCHED THE WAY A USER FETCHES THEM.
 *
 * Every install command the app and the site print — the connect wizard, the desktop sync command, the
 * "Connect this device" dialog on a capability card — is `curl -fsSL <vanity URL> | sh` or `irm <vanity URL> |
 * iex`. The URL comes from @intentic/constants' INSTALL_SCRIPTS, and the thing that answers it is the site
 * worker (_site/site/worker.ts), which reads the SAME table and serves the file it names out of
 * public/scripts/. One table, two deployments — the app and the site ship separately, and nothing in this
 * repository has ever checked that the second one can answer what the first one promises.
 *
 * WHAT THAT COST, and why this file exists: b266789b5 renamed the device scripts (computer.* -> device.*). The
 * app started handing out https://intentic.dev/device.ps1 the moment it deployed. The site did not deploy at
 * all — for unrelated reasons, for eight days — so intentic.dev went on serving /computer.ps1 and answered
 * /device.ps1 with the marketing 404 page, which the worker dutifully re-labelled `text/plain` and piped into
 * somebody's PowerShell. Every check in this repo was green throughout: the table was consistent, the file was
 * committed, the worker was correct. The only thing wrong was live, and nothing was looking at live.
 *
 * THE CONTRACT, per vanity path: 200, `text/plain`, a non-empty body that is not HTML. That is the whole of it,
 * and it is deliberately not a byte-comparison against the working tree. The site publishes outside this
 * pipeline, so a commit that lands after the last site deploy legitimately leaves the two a few hours apart;
 * asserting equality would paint this red on any night main moved, and a canary that is always red is a canary
 * nobody reads. What it does assert is the failure that actually happens and is never otherwise noticed: a path
 * the product tells people to run that answers with anything other than a script.
 *
 * Reads no credential and writes nothing. Run it anywhere: `node _tools/scripts/ci/check-install-urls.mjs`.
 */
import { INSTALL_SCRIPTS, installScriptUrl } from "@intentic/constants";

const TIMEOUT_MS = 15_000;

/* One vanity path, fetched. GET rather than HEAD: HEAD is the request nobody serves correctly, and the body is
 * half the assertion — a 200 that hands back the 404 page is the exact shape of the bug this looks for. */
async function probe(key) {
    const url = installScriptUrl(key);
    const file = INSTALL_SCRIPTS[key].file;
    try {
        const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
        const body = await response.text();
        const type = response.headers.get("content-type") ?? "";
        if (response.status !== 200) {
            return { key, url, file, ok: false, why: `HTTP ${response.status} — the site does not serve this path` };
        }
        if (!type.includes("text/plain")) {
            return { key, url, file, ok: false, why: `content-type ${type || "(none)"}, expected text/plain` };
        }
        // The worker relabels whatever the asset layer returns, so the 404 page can arrive wearing text/plain.
        if (body.trim() === "" || /^\s*<(?:!doctype|html)/iu.test(body)) {
            return { key, url, file, ok: false, why: `body is ${body.trim() === "" ? "empty" : "HTML, not a script"}` };
        }
        return { key, url, file, ok: true, why: `${body.split("\n").length} lines` };
    } catch (error) {
        return { key, url, file, ok: false, why: `request failed: ${error instanceof Error ? error.message : String(error)}` };
    }
}

const results = await Promise.all(Object.keys(INSTALL_SCRIPTS).map(probe));
results.sort((a, b) => a.url.localeCompare(b.url));

for (const result of results) {
    console.log(`${result.ok ? "ok  " : "FAIL"}  ${result.url}  (${result.file})  ${result.why}`);
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} install URLs serve a script.`);
if (failed.length > 0) {
    console.error(
        `\n${failed.length} install URL(s) the product hands out do not serve a script. This is what a user's` +
            ` terminal gets. The usual cause is the site not having deployed since the scripts changed —` +
            ` _site/site is published from Cloudflare, outside this pipeline: \`pnpm --filter @intentic/site deploy\`.`,
    );
    process.exit(1);
}
