import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The popup, opened in an ordinary tab for design work and store screenshots: the same popup.js/popup.html the
// extension ships, `chrome` replaced by a stub, so a wiring bug still shows. Not shipped: pack.mjs excludes it by name.
// pnpm --filter @intentic/webext build && node _devices/webext/scripts/preview.mjs → dist/preview.html, to open in any
// browser

const here = import.meta.dirname;
const dist = join(here, "..", "dist");

// The state a listing screenshot should show: connected, working, and something waiting for the person, all
// visible at once.
const STATE = {
    sandbox: { url: "https://sandbox-4f2a91c7b8e0.intentic.dev", token: "" },
    link: "open",
    scopes: { read: "on", act: "on", screenshot: "off", cookies: "off", confirm: "sensitive" },
    grants: [
        { origin: "https://github.com/*", mode: "act" },
        { origin: "https://acme.atlassian.net/*", mode: "act" },
        { origin: "https://docs.stripe.com/*", mode: "read" },
    ],
    pending: { origin: "https://mail.google.com/*", reason: "To read the invoice thread you asked me to summarise.", at: Date.now() - 24_000 },
    offered: undefined,
    paused: false,
    log: [
        { at: Date.now() - 8_000, tool: "click", detail: `{"ref":"e14"} — clicked "Create pull request"`, ok: true },
        { at: Date.now() - 21_000, tool: "fill", detail: `{"ref":"e9","text":"<86 characters>","submit":false}`, ok: true },
        { at: Date.now() - 44_000, tool: "snapshot", detail: `{}`, ok: true },
        { at: Date.now() - 51_000, tool: "tabs", detail: `{}`, ok: true },
        { at: Date.now() - 92_000, tool: "snapshot", detail: `{} — refused: not allowed on mail.google.com`, ok: false },
    ],
};

const stub = `<script>
// The stub. Everything the popup reaches for, and nothing else — which is also a readable list of what a
// popup is allowed to touch.
window.chrome = {
    runtime: { sendMessage: async (message) => (message.type === "state" ? ${JSON.stringify(STATE)} : { ok: true }) },
    tabs: { query: async () => [{ id: 1, url: "https://news.ycombinator.com/item?id=1", title: "Hacker News" }] },
    permissions: { request: async () => true, remove: async () => true },
};
</script>`;

const html = readFileSync(join(dist, "popup.html"), "utf8").replace(
    '<script src="popup.js"></script>',
    `${stub}\n        <script src="popup.js"></script>`,
);
writeFileSync(join(dist, "preview.html"), html);

// The store shot: the same popup at the exact 1280×800 a listing needs, in an iframe so a reviewer sees the real
// popup, not an artist's impression.
// Screenshot at 1280×800, or: (cd dist && python3 -m http.server 8791), capture http://127.0.0.1:8791/store-shot.html
const shot = `<!doctype html>
<html lang="en">
    <head>
        <meta charset="utf-8" />
        <title>Intentic — store shot</title>
        <style>
            html, body { margin: 0; width: 1280px; height: 800px; overflow: hidden; }
            body {
                display: flex; align-items: center; gap: 72px; padding: 0 90px; box-sizing: border-box;
                background: radial-gradient(120% 120% at 15% 10%, #15100b 0%, #0c0907 60%);
                color: #efe3cd; font: 16px/1.5 system-ui, sans-serif;
            }
            h1 { font-size: 40px; line-height: 1.15; margin: 0 0 18px; letter-spacing: -0.02em; }
            p { margin: 0 0 14px; color: #b7a68d; max-width: 30ch; font-size: 18px; }
            b { color: #efe3cd; font-weight: 600; }
            .accent { color: #f59b3f; }
            .mark { width: 64px; height: 64px; margin: 0 0 26px; display: block; }
            iframe { width: 368px; height: 640px; border: 0; border-radius: 14px; background: #fff; box-shadow: 0 30px 80px rgba(0,0,0,.55); }
        </style>
    </head>
    <body>
        <div>
            <img class="mark" src="icons/icon-128.png" alt="" />
            <h1>Your agent,<br /><span class="accent">in your browser.</span></h1>
            <p>It works on the sites <b>you allow</b> — one at a time, granted here, revoked in Chrome.</p>
            <p>You watch it happen: every action is drawn on the page, and anything that spends money or deletes something asks you first.</p>
            <p>Pause it in one click.</p>
        </div>
        <iframe src="preview.html" title="The extension's popup"></iframe>
    </body>
</html>`;
writeFileSync(join(dist, "store-shot.html"), shot);
console.log("dist/preview.html: the popup at its real 340px width.");
console.log("dist/store-shot.html: the listing screenshot, at 1280x800.");
