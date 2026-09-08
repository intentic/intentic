#!/usr/bin/env node
// Fetches the deployed demo live and asserts the shell, the hashed entry bundle it names, and the import-map shims all
// answer 200; not a comparison against the working tree, since the site (`_site/site/worker.ts`) deploys separately
// from this pipeline. Reads no credential, writes nothing.
import { PLATFORM_SITE_ORIGIN } from "@intentic/constants";

const TIMEOUT_MS = 15_000;
const DEMO_URL = `${PLATFORM_SITE_ORIGIN}/demo/`;

// The shell's own <title>. A 200 is not enough on its own: the worker serves /demo/index.html for any /demo/ document
// request, and the asset layer answers a real miss with the site's 404 page, so the body is what tells them apart.
const SHELL_MARKER = "interactive demo";

async function probe(url, what, assert) {
    try {
        const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
        const body = await response.text();
        const type = response.headers.get("content-type") ?? "";
        if (response.status !== 200) {
            return { url, what, ok: false, why: `HTTP ${response.status} — the site does not serve this path`, body };
        }
        const why = assert({ type, body });
        return { url, what, ok: why === undefined, why: why ?? `${body.length} bytes`, body };
    } catch (error) {
        const why = `request failed: ${error instanceof Error ? error.message : String(error)}`;
        return { url, what, ok: false, why, body: "" };
    }
}

const isScript = ({ type }) => (type.includes("javascript") ? undefined : `content-type ${type || "(none)"}, expected javascript`);

const isShell = ({ type, body }) => {
    if (!type.includes("text/html")) {
        return `content-type ${type || "(none)"}, expected text/html`;
    }
    return body.includes(SHELL_MARKER) ? undefined : "body is HTML but not the demo shell (the 404 page?)";
};

const shell = await probe(DEMO_URL, "shell", isShell);

// Read out of the shell rather than pinned: the entry's hash changes every build, and this bundle is exactly what a
// deploy that skipped the demo build leaves out.
const entry = /<script type="module"[^>]*src="(?<src>\/demo\/[^"]+)"/u.exec(shell.body)?.groups?.src;
// The import map's targets are the app's own public/ files, outside Vite's asset graph, so they can go missing alone.
const shims = [...shell.body.matchAll(/"(?<url>\/demo\/ext-shims\/[^"]+\.js)"/gu)].map((match) => match.groups.url);

const assets = shell.ok
    ? await Promise.all(
          [...(entry === undefined ? [] : [[entry, "entry bundle"]]), ...shims.map((url) => [url, "import-map shim"])].map(([url, what]) =>
              probe(new URL(url, PLATFORM_SITE_ORIGIN).href, what, isScript),
          ),
      )
    : [];

const results = [shell, ...assets];
for (const result of results) {
    console.log(`${result.ok ? "ok  " : "FAIL"}  ${result.url}  (${result.what})  ${result.why}`);
}

if (shell.ok && entry === undefined) {
    console.error("\nThe demo shell names no module entry — its build produced a document with no application in it.");
    process.exit(1);
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} demo URLs serve what they should.`);
if (failed.length > 0) {
    console.error(
        `\n${failed.length} demo URL(s) the landing page links to are not live. This is what a visitor who presses` +
            ` play gets. The usual cause is a site deploy that never built the demo: its output lives in the site's` +
            ` gitignored public/demo/, so a fresh checkout ships /demo/ empty unless the demo's own build ran first.` +
            ` _site/site/wrangler.jsonc's build.command runs it; \`pnpm --filter @intentic/site run deploy\` is the` +
            ` deploy that runs that.`,
    );
    process.exit(1);
}
