#!/usr/bin/env node
// Fetches each vanity install URL live and asserts 200, `text/plain`, a non-empty non-HTML body; not a byte-comparison
// against the working tree, since the site (`_site/site/worker.ts`) deploys separately from this pipeline. Reads no
// credential, writes nothing.
import { INSTALL_SCRIPTS, installScriptUrl } from "@intentic/constants";

const TIMEOUT_MS = 15_000;

// GET, not HEAD (unreliable here); the body is half the check, since a 200 wrapping the 404 page is exactly the failure
// this looks for.
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
        // The worker relabels whatever the asset layer returns; a 404 page can arrive as text/plain.
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
            ` _site/site is published from Cloudflare, outside this pipeline: \`pnpm --filter @intentic/site run deploy\`.`,
    );
    process.exit(1);
}
