import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/* THE POPUP, OPENABLE IN AN ORDINARY TAB — for looking at, and for the store listing's screenshots.
 *
 * A popup is 340 pixels that exist for about four seconds, inside a browser that will not let you inspect it
 * comfortably, in a state (paired, three sites allowed, a pending request) that takes a working sandbox and a
 * real browser to reach. That is a bad loop for design work and an impossible one for a screenshot somebody
 * has to retake whenever the listing changes.
 *
 * So: the same popup.js the extension ships, over the same popup.html, with `chrome` replaced by a stub that
 * answers with a plausible state. Nothing about the popup itself is mocked — if a button is wired to the wrong
 * message, this shows it.
 *
 *   pnpm --filter @intentic/webext build && node _computers/webext/scripts/preview.mjs
 *   → dist/preview.html, to open in any browser
 *
 * NOT SHIPPED: it is written into dist/ (so the relative `popup.js` resolves) and pack.mjs skips it by name,
 * which is the one thing that keeps a debugging surface out of a signed artifact.
 */

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");

// The state a listing screenshot should show: connected, working, with something waiting for the person — the
// three things the popup exists to say, all visible at once.
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

/* THE STORE SHOT: the same popup, at the exact 1280×800 a listing screenshot has to be, on a backdrop that
 * says in three lines what the extension is. An iframe rather than a second render, so what a reviewer sees is
 * the real popup at its real width and not an artist's impression of it.
 *
 * Screenshot it with any browser at 1280×800, or:
 *   (cd dist && python3 -m http.server 8791) then capture http://127.0.0.1:8791/store-shot.html
 */
const shot = `<!doctype html>
<html lang="en">
    <head>
        <meta charset="utf-8" />
        <title>Intentic — store shot</title>
        <style>
            html, body { margin: 0; width: 1280px; height: 800px; overflow: hidden; }
            body {
                display: flex; align-items: center; gap: 72px; padding: 0 90px; box-sizing: border-box;
                background: radial-gradient(120% 120% at 15% 10%, #1b1b28 0%, #0d0d14 60%);
                color: #f4f4f8; font: 16px/1.5 system-ui, sans-serif;
            }
            h1 { font-size: 40px; line-height: 1.15; margin: 0 0 18px; letter-spacing: -0.02em; }
            p { margin: 0 0 14px; color: #b6b6c6; max-width: 30ch; font-size: 18px; }
            b { color: #f4f4f8; font-weight: 600; }
            .accent { color: #a08cff; }
            iframe { width: 368px; height: 640px; border: 0; border-radius: 14px; background: #fff; box-shadow: 0 30px 80px rgba(0,0,0,.55); }
        </style>
    </head>
    <body>
        <div>
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
