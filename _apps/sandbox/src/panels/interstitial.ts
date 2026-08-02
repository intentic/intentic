// Where the interstitial's CTA sends a viewer who just opened someone's shared link — the "invite" half of the
// share loop (the "demo" half is the working preview, or the published file, itself). These status pages are the
// ONLY surface Intentic controls end-to-end (they are served by the preview proxy, never injected into the
// user's running app), so the attribution lives here and nowhere intrusive.
const INTENTIC_URL = "https://intentic.dev";

// Only the dynamic bits of a status message (a repo/slot/file name derived from the attacker-controllable Host
// or request path) are escaped before landing in HTML; the static sentence around them is author-controlled.
export const escapeHtml = (value: string): string =>
    value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);

// A small, self-contained branded page for every status response the sandbox's public HTTP surface produces —
// the proxy's (panel not up, nothing forwarded, dead upstream, stray host) and the outbox's (no such file, no
// listing, refused). Inline everything — the bare http server behind these ships no assets. `message` is
// embedded as text content (its only dynamic parts are pre-escaped at the call site; literal quotes stay
// literal, which the proxy tests rely on). Shown at exactly the high-intent moment a viewer clicks a shared link.
export const interstitial = (title: string, message: string): string =>
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>:root{color-scheme:dark light}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e6e8eb;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}.card{max-width:26rem;padding:2rem;text-align:center}h1{margin:0 0 .5rem;font-size:1.05rem;font-weight:600}p{margin:0;color:#9aa0a6}a.cta{display:inline-block;margin-top:1.5rem;padding-top:1.2rem;border-top:1px solid #1e2227;color:#8ab4f8;text-decoration:none;font-size:.8rem}a.cta:hover{text-decoration:underline}</style></head><body><div class="card"><h1>${title}</h1><p>${message}</p><a class="cta" href="${INTENTIC_URL}" target="_blank" rel="noopener">Preview powered by <b>Intentic</b> — build &amp; share your own →</a></div></body></html>`;

// A terminal answer for a public request: the status page to render instead of any content. The proxy and the
// outbox both resolve a request to either something to serve or one of these.
export interface Refusal {
    readonly status: number;
    readonly title: string;
    readonly message: string;
}
