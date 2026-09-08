// CTA for the interstitial: Intentic's only surface controlled end-to-end, served by the proxy, never injected.
const INTENTIC_URL = "https://intentic.dev";

// Escapes only the dynamic bits of a status message (repo/slot/file name from an attacker-controlled Host or path); the
// static sentence is author-controlled.
export const escapeHtml = (value: string): string =>
    value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);

// Branded status page for every response on the sandbox's public HTTP surface; inlined since this server ships no
// assets. `message` is text content, pre-escaped at the call site; literal quotes must stay literal.
export const interstitial = (title: string, message: string): string =>
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>:root{color-scheme:dark light}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e6e8eb;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}.card{max-width:26rem;padding:2rem;text-align:center}h1{margin:0 0 .5rem;font-size:1.05rem;font-weight:600}p{margin:0;color:#9aa0a6}a.cta{display:inline-block;margin-top:1.5rem;padding-top:1.2rem;border-top:1px solid #1e2227;color:#8ab4f8;text-decoration:none;font-size:.8rem}a.cta:hover{text-decoration:underline}</style></head><body><div class="card"><h1>${title}</h1><p>${message}</p><a class="cta" href="${INTENTIC_URL}" target="_blank" rel="noopener">Preview powered by <b>Intentic</b>: build &amp; share your own →</a></div></body></html>`;

// Terminal answer for a public request: a status page instead of content. The proxy and outbox both resolve a request
// to one of these or something to serve.
export interface Refusal {
    readonly status: number;
    readonly title: string;
    readonly message: string;
}
