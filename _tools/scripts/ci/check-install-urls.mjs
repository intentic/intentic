#!/usr/bin/env node
// Fetches each vanity install URL and one sample of each one-liner verb route live, and asserts 200, `text/plain`, a non-empty non-HTML body; not a byte-comparison
// against the working tree, since the site (`_site/site/worker.ts`) deploys separately from this pipeline. Reads no
// credential, writes nothing.
import { INSTALL_SCRIPTS, installScriptUrl, oneLinerUrl } from "@intentic/constants";

const TIMEOUT_MS = 15_000;

// The one-liner routes (`/<verb>/<arg>`), one sample per verb with well-formed made-up arguments: the Worker injects
// them into the same scripts without checking that the sandbox or code exists, so a 200 here means the route works.
// Each once as sh and once with the `.ps1` override.
const VERB_SAMPLES = [
    ["setup", ["Abc123XYZ"]],
    ["setup", ["Abc123XYZ", "my-project"]],
    ["fix", ["Q7XK2M9P"]],
    ["update", ["sandbox-example"]],
    ["rollback", ["sandbox-example"]],
    ["restart", ["sandbox-example"]],
    ["rebuild", ["sandbox-example", "0123abcd"]],
    ["remove", ["sandbox-example"]],
    ["remove", []],
    ["device", ["sandbox-example.intentic.app", "AB12CD34"]],
    ["sync", ["sandbox-example.intentic.app", "AB12CD34"]],
    ["server", ["sandbox-example.intentic.app", "AB12CD34"]],
];

const verbTargets = VERB_SAMPLES.flatMap(([verb, args]) => {
    const url = oneLinerUrl(verb, args);
    return [
        { key: verb, url, file: `${verb} sh`, expect: (body) => body.includes("\nINTENTIC_SCRIPT_URL=") },
        { key: verb, url: `${url}.ps1`, file: `${verb} ps1`, expect: (body) => body.startsWith("& {") },
    ];
});

const flatTargets = Object.keys(INSTALL_SCRIPTS).map((key) => ({ key, url: installScriptUrl(key), file: INSTALL_SCRIPTS[key].file }));

// GET, not HEAD (unreliable here); the body is half the check, since a 200 wrapping the 404 page is exactly the failure
// this looks for.
async function probe({ key, url, file, expect }) {
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
        if (expect !== undefined && !expect(body)) {
            return { key, url, file, ok: false, why: "the script came back without its arguments injected" };
        }
        return { key, url, file, ok: true, why: `${body.split("\n").length} lines` };
    } catch (error) {
        return { key, url, file, ok: false, why: `request failed: ${error instanceof Error ? error.message : String(error)}` };
    }
}

const results = await Promise.all([...flatTargets, ...verbTargets].map(probe));
results.sort((a, b) => a.url.localeCompare(b.url));

for (const result of results) {
    console.log(`${result.ok ? "ok  " : "FAIL"}  ${result.url}  (${result.file})  ${result.why}`);
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} install URLs serve a script.`);
if (failed.length > 0) {
    console.error(
        `\n${failed.length === 1 ? "1 install URL" : `${failed.length} install URLs`} the product hands out ${failed.length === 1 ? "does" : "do"} not serve a script. This is what a user's` +
            ` terminal gets. The usual cause is the site not having deployed since the scripts changed —` +
            ` _site/site is published from Cloudflare, outside this pipeline: \`pnpm --filter @intentic/site run deploy\`.`,
    );
    process.exit(1);
}
