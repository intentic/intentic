import { PLATFORM_SITE_ORIGIN } from "@intentic/constants";
import { escapeHtml } from "@intentic/base/format";

// What a page may add under its message: one button-like link (`href` raw, escaped here; `label` text, pre-escaped),
// and one inline script the page runs as it loads (a constant of the caller's, never anything a visitor sent).
export interface InterstitialExtras {
    readonly action?: { readonly label: string; readonly href: string };
    readonly script?: string;
}

// Branded status page for every response on the sandbox's public HTTP surface; inlined since this server ships no
// assets. `message` is text content, pre-escaped at the call site; literal quotes must stay literal. `refreshSeconds`
// reloads the page by itself, for a state that is about to change (a server starting).
export const interstitial = (title: string, message: string, refreshSeconds?: number, extras: InterstitialExtras = {}): string =>
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refreshSeconds === undefined ? "" : `<meta http-equiv="refresh" content="${String(Math.max(1, Math.round(refreshSeconds)))}">`}<title>${title}</title><style>:root{color-scheme:dark light}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e6e8eb;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}.card{max-width:26rem;padding:2rem;text-align:center}h1{margin:0 0 .5rem;font-size:1.05rem;font-weight:600}p{margin:0;color:#9aa0a6}a.go{display:inline-block;margin-top:1.25rem;padding:.55rem 1.1rem;border-radius:.5rem;background:#8ab4f8;color:#0b0d10;font-weight:600;text-decoration:none}a.go:hover{background:#a8c7fa}a.cta{display:inline-block;margin-top:1.5rem;padding-top:1.2rem;border-top:1px solid #1e2227;color:#8ab4f8;text-decoration:none;font-size:.8rem}a.cta:hover{text-decoration:underline}</style></head><body><div class="card"><h1>${title}</h1><p>${message}</p>${extras.action === undefined ? "" : `<a class="go" id="go" href="${escapeHtml(extras.action.href)}">${extras.action.label}</a><br>`}<a class="cta" href="${PLATFORM_SITE_ORIGIN}" target="_blank" rel="noopener">Preview powered by <b>Intentic</b>: build &amp; share your own →</a></div>${extras.script === undefined ? "" : `<script>${extras.script}</script>`}</body></html>`;

// Terminal answer for a public request: a status page instead of content. The proxy and outbox both resolve a request
// to one of these or something to serve.
export interface Refusal {
    readonly status: number;
    readonly title: string;
    readonly message: string;
    // Seconds after which the page reloads itself; absent for a state that will not change by waiting.
    readonly refreshSeconds?: number;
}
