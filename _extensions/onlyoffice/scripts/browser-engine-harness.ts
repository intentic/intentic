// The browser engine end to end, without a sandbox: the real bundle store (downloading the pinned bundle), the real
// listener and browser engine, this package's built editor page, and a stand-in for the viewer on a second origin that
// frames the editor and records what the page says. For checking a new pin, or a change to the page, in a browser:
//
//   pnpm --filter @intentic/ext-onlyoffice build
//   bun scripts/browser-engine-harness.ts --workspace /tmp/oo-work [--cache /tmp/oo-cache] [--port 8790]
//
// then open http://localhost:<port + 1>/?path=<file in the workspace>[&mode=view][&agent=x]. The viewer page keeps
// every message in `window.heard`, and `window.tell({ type: "save" })` (or "sync", or resolve with a choice) speaks to
// the editor page the way the viewer does.
import { mkdir, stat } from "node:fs/promises";
import http from "node:http";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BUNDLE_PIN } from "../src/server/bundle-pin.js";
import { BundleStore } from "../src/server/bundle.js";
import { createBrowserEngine } from "../src/server/browser-engine.js";
import { createListener } from "../src/server/listener.js";
import { Sessions } from "../src/server/sessions.js";

const { values } = parseArgs({
    options: {
        workspace: { type: `string` },
        cache: { type: `string`, default: `/tmp/onlyoffice-bundle-cache` },
        port: { type: `string`, default: `8790` },
    },
});
if (values.workspace === undefined) {
    console.error(`usage: bun scripts/browser-engine-harness.ts --workspace DIR [--cache DIR] [--port N]`);
    process.exit(2);
}
const workspace = resolve(values.workspace);
const port = Number(values.port);
const listenerOrigin = `http://localhost:${port}`;
const viewerOrigin = `http://localhost:${port + 1}`;

const sessions = new Sessions();
const bundle = new BundleStore({ root: resolve(values.cache), pin: BUNDLE_PIN, log: (line) => console.log(`[bundle] ${line}`) });
await mkdir(resolve(values.cache), { recursive: true });
const engine = createBrowserEngine({
    workspaceRoot: workspace,
    pageDir: resolve(import.meta.dirname, `..`, `dist`, `editor`),
    sessions,
    bundle,
    // A conversation's copy stands in as the shared file's own bytes.
    scopedRaw: async (path) => {
        const file = Bun.file(join(workspace, path));
        return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
    },
    identify: async (path, agent) => {
        if (agent !== undefined) {
            return { digest: `harness-copy` };
        }
        try {
            const found = await stat(join(workspace, path));
            return { stat: { size: found.size, mtimeMs: found.mtimeMs } };
        } catch {
            // allow(silent-catch): a missing file is the undefined the engine answers 404 for.
            return undefined;
        }
    },
    exposure: async () => listenerOrigin,
    log: (line) => console.log(`[engine] ${line}`),
});
const listener = createListener({
    secret: `harness`,
    sessions,
    documentServerPort: () => undefined,
    pageFor: (session) => engine.page(session),
    refresh: async () => undefined,
    readDocument: async () => undefined,
    saveDocument: async () => {
        throw new Error(`the harness runs no document server`);
    },
    browser: engine.routes,
    log: (line) => console.log(`[listener] ${line}`),
});
await listener.listen(port);

// The viewer's stand-in: asks the engine for a session the way the backend's /open does, frames the page, and records.
const viewerPage = `<!doctype html><html><head><meta charset="utf-8"><title>viewer</title>
<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style></head><body>
<script>
const params = new URLSearchParams(location.search);
window.heard = [];
window.frameOrigin = ${JSON.stringify(listenerOrigin)};
window.addEventListener("message", (event) => {
    if (event.origin === window.frameOrigin && event.data && event.data.channel === "intentic.onlyoffice") {
        window.heard.push(event.data);
    }
});
window.tell = (message) => document.querySelector("iframe").contentWindow.postMessage({ channel: "intentic.onlyoffice", ...message }, window.frameOrigin);
fetch("/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    path: params.get("path"), mode: params.get("mode") || "edit", theme: params.get("theme") || "light", engine: "browser",
    lang: params.get("lang") || "en", origin: location.origin, ...(params.get("agent") ? { agent: params.get("agent") } : {}),
}) }).then((r) => r.json()).then((answer) => {
    window.opened = answer;
    if (answer.url) {
        const frame = document.createElement("iframe");
        frame.src = answer.url;
        frame.allow = "clipboard-read; clipboard-write";
        document.body.append(frame);
    }
});
</script></body></html>`;

const viewer = http.createServer((req, res) => {
    const url = new URL(req.url ?? `/`, viewerOrigin);
    // Open to any origin, so a local copy of the app (the demo build's daemon, say) can ask for a session too.
    res.setHeader(`access-control-allow-origin`, `*`);
    res.setHeader(`access-control-allow-headers`, `content-type`);
    if (req.method === `OPTIONS`) {
        res.writeHead(204);
        res.end();
        return;
    }
    if (req.method === `POST` && url.pathname === `/open`) {
        const chunks: Buffer[] = [];
        req.on(`data`, (chunk: Buffer) => chunks.push(chunk));
        req.on(`end`, () => {
            void engine.open(JSON.parse(Buffer.concat(chunks).toString(`utf8`))).then((answer) => {
                res.writeHead(answer.status, { "content-type": `application/json` });
                res.end(JSON.stringify(answer.body));
            });
        });
        return;
    }
    res.writeHead(200, { "content-type": `text/html; charset=utf-8`, "cache-control": `no-store` });
    res.end(viewerPage);
});
viewer.listen(port + 1);

console.log(`listener on ${listenerOrigin}, viewer on ${viewerOrigin}; preparing the bundle…`);
await bundle.ensure();
const ready = await bundle.settled();
console.log(`bundle: ${JSON.stringify(ready)}`);
console.log(`open ${viewerOrigin}/?path=<file under ${workspace}>`);
