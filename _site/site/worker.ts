import { INSTALL_SCRIPTS, PLATFORM_WEB_ORIGIN } from "@intentic/constants";
import { DESKTOP_ROUTES, RELEASES_URL } from "./src/lib/desktop-downloads";
import { type LiveContent, LIVE_CACHE_SECONDS, LIVE_CONTENT_URL, type LiveSwitch, parseLiveContent } from "./src/lib/live";

// Vanity install-script paths, from @intentic/constants' table, which the app also writes into its one-liners.
const SCRIPTS: Record<string, string> = Object.fromEntries(Object.values(INSTALL_SCRIPTS).map((script) => [script.path, script.file]));

// /product/<verb> now redirects to /features/<verb>; kept since URLs, unlike labels, get bookmarked elsewhere.
const MOVED_VERBS: Record<string, string> = {
    orchestrate: "run",
    empower: "connect",
    supervise: "review",
    delegate: "host",
};

// Pages moved to a different book, matched exactly not by prefix; redirects into the generated /api/ page.
const MOVED_PAGES: Record<string, string> = {
    "/developers/http": "/api/",
};

function movedPath(pathname: string): string | undefined {
    const exact = MOVED_PAGES[pathname.replace(/\/$/u, "")];
    if (exact !== undefined) {
        return exact;
    }
    let moved: string | undefined;
    if (pathname === "/product" || pathname.startsWith("/product/")) {
        const [verb = "", ...tail] = pathname.slice("/product".length).replace(/^\//u, "").split("/");
        moved = ["/features", MOVED_VERBS[verb] ?? verb, ...tail].join("/");
    }
    if (moved === undefined) {
        return undefined;
    }
    // trailingSlash: "always": a moved page needs the slashed form; real files (.md, llms.txt) keep their name.
    return /\.[a-z0-9]+$/iu.test(moved) || moved.endsWith("/") ? moved : `${moved}/`;
}

// HSTS on every https response, so a return visit skips the plaintext hop; `preload` is intentionally unset.
const HSTS = "max-age=31536000; includeSubDomains";

// /sitemap.xml is where naive tools guess; the real document is /sitemap-index.xml, named in robots.txt.
const SITEMAP_ALIAS = "/sitemap.xml";

// A `.md` mirror cannot carry `<link rel=canonical>`, so this sets it via header, pointing at the matching page;
// otherwise the pair reads as duplicate content.
function canonicalForMarkdown(pathname: string): string | undefined {
    if (!pathname.endsWith(".md")) {
        return undefined;
    }
    const withoutExt = pathname.slice(0, -".md".length);
    return withoutExt === "/index" ? "/" : `${withoutExt}/`;
}

// Desktop download URLs never carry a version; the resolved file does. Path table shared with the dev server.

// Resolved download memoised per platform for an hour; verifies the release actually carries the asset first.
const DOWNLOAD_TTL_MS = 60 * 60 * 1000;
const downloadCache = new Map<string, { url: string; at: number }>();

async function resolveDownload(asset: (version: string) => string, key: string): Promise<string> {
    const cached = downloadCache.get(key);
    if (cached !== undefined && Date.now() - cached.at < DOWNLOAD_TTL_MS) {
        return cached.url;
    }
    let resolved = `${RELEASES_URL}/latest`;
    try {
        const latest = await fetch(`${RELEASES_URL}/latest`, { redirect: "manual" });
        const version = /\/releases\/tag\/v(?<version>[^/?#]+)$/u.exec(latest.headers.get("location") ?? "")?.groups?.version;
        if (version !== undefined) {
            const candidate = `${RELEASES_URL}/download/v${version}/${asset(version)}`;
            // An asset that exists answers a HEAD with a redirect to storage; one that does not answers 404.
            const probe = await fetch(candidate, { method: "HEAD", redirect: "manual" });
            if (probe.status < 400) {
                resolved = candidate;
            }
        }
    } catch {
        // Offline, rate-limited, or the redirect shape moved, the releases-page fallback stands.
    }
    downloadCache.set(key, { url: resolved, at: Date.now() });
    return resolved;
}

// Live document, read per request and memoised for LIVE_CACHE_SECONDS; any failure leaves the page as built.
const LIVE_TTL_MS = LIVE_CACHE_SECONDS * 1000;
let liveCache: { content: LiveContent | undefined; at: number } | undefined;

async function liveContent(): Promise<LiveContent | undefined> {
    if (liveCache !== undefined && Date.now() - liveCache.at < LIVE_TTL_MS) {
        return liveCache.content;
    }
    let content: LiveContent | undefined;
    try {
        const response = await fetch(LIVE_CONTENT_URL, { cf: { cacheTtl: LIVE_CACHE_SECONDS, cacheEverything: true } });
        if (response.ok) {
            content = parseLiveContent(await response.json());
        }
    } catch {
        // Unreachable, rate-limited, or not JSON at all. The built page stands.
    }
    liveCache = { content, at: Date.now() };
    return content;
}

// Switch controls matched by what a control already looks like (`a.btn` to the app host, or a download href).
const APP_HOST = new URL(PLATFORM_WEB_ORIGIN).host;
const WORKSPACE_CONTROLS = `a.btn[href*="${APP_HOST}"]`;
const DOWNLOAD_CONTROLS = "a[data-download-cta], a[href^='/desktop/']";

// Closes an `<a>`: removes `href` (inert and unfocusable everywhere, stronger than styling) rather than repointing it,
// and sets the reason as its `title`; the notice strip carries the visible explanation.
const disable = (control: LiveSwitch) => ({
    element(element: HTMLRewriterElement) {
        element.removeAttribute("href");
        element.setAttribute("aria-disabled", "true");
        element.setAttribute("data-live-disabled", "");
        if (control.reason !== "") {
            element.setAttribute("title", control.reason);
        }
    },
});

// Overrides the built page with the live document; every handler edits existing markup only, and `setInnerContent`
// escapes by default. Marked `must-revalidate`, since a cached notice could otherwise not be taken down.
function withLiveContent(response: Response, live: LiveContent): Response {
    const { notice, switches } = live;
    let rewriter = new HTMLRewriter()
        .on("[data-live-notice]", {
            element(element) {
                if (notice.active) {
                    element.removeAttribute("hidden");
                } else {
                    element.setAttribute("hidden", "");
                }
                element.setAttribute("data-tone", notice.tone);
            },
        })
        .on("[data-live-notice-message]", {
            element(element) {
                element.setInnerContent(notice.message);
            },
        })
        .on("[data-live-notice-link]", {
            element(element) {
                if (notice.active && notice.href !== "") {
                    element.removeAttribute("hidden");
                    element.setAttribute("href", notice.href);
                    element.setInnerContent(notice.linkLabel);
                } else {
                    element.setAttribute("hidden", "");
                }
            },
        });
    if (!switches.workspace.enabled) {
        rewriter = rewriter.on(WORKSPACE_CONTROLS, disable(switches.workspace));
    }
    if (!switches.download.enabled) {
        rewriter = rewriter.on(DOWNLOAD_CONTROLS, disable(switches.download));
    }
    const headers = new Headers(response.headers);
    headers.set("cache-control", "public, max-age=0, must-revalidate");
    return rewriter.transform(new Response(response.body, { status: response.status, statusText: response.statusText, headers }));
}

// Redirects http to https, folding in any moved path so a legacy plaintext link takes one hop, not two. Without this
// every page had a crawlable plaintext twin splitting search signals.
function httpsRedirect(url: URL): Response | undefined {
    if (url.protocol !== "http:") {
        return undefined;
    }
    const secure = new URL(url.href);
    secure.protocol = "https:";
    secure.pathname = movedPath(url.pathname) ?? url.pathname;
    return Response.redirect(secure.href, 301);
}

export default {
    async fetch(request: Request, env: { ASSETS: { fetch: typeof fetch } }): Promise<Response> {
        const url = new URL(request.url);

        const secure = httpsRedirect(url);
        if (secure !== undefined) {
            return secure;
        }

        // Read once per request and handed to the route: two of its three effects are the route's own decisions.
        const live = await liveContent();
        const response = await route(request, url, env, live);

        // Rewrite only documents; `/demo/` is skipped since it is an app with no notice strip or controls to rewrite.
        const isDocument = response.headers.get("content-type")?.includes("text/html") === true;
        const shaped = live !== undefined && isDocument && !url.pathname.startsWith("/demo") ? withLiveContent(response, live) : response;

        // Header sets are immutable on a response that came from fetch(), so this is a copy either way.
        const headers = new Headers(shaped.headers);
        headers.set("strict-transport-security", HSTS);
        return new Response(shaped.body, { status: shaped.status, statusText: shaped.statusText, headers });
    },
};

// Desktop download route, split out from `route` since it is the only branch that makes its own decision rather than
// just picking an asset.
async function desktopDownload(
    download: (typeof DESKTOP_ROUTES)[string],
    request: Request,
    url: URL,
    env: { ASSETS: { fetch: typeof fetch } },
    live: LiveContent | undefined,
): Promise<Response> {
    // The switch is the route's: these URLs are published everywhere, so a dimmed button alone would not stop it.
    if (live?.switches.download.enabled === false) {
        return Response.redirect(new URL("/download/", url).href, 302);
    }
    const staged = await env.ASSETS.fetch(new Request(new URL(`/desktop/${download.staged}`, url), request));
    if (staged.ok) {
        const headers = new Headers(staged.headers);
        headers.set("content-disposition", `attachment; filename="${download.staged}"`);
        return new Response(staged.body, { status: staged.status, headers });
    }
    // Keyed on the staged name, not the route, so /desktop and /desktop/windows share one resolution.
    return Response.redirect(await resolveDownload(download.asset, download.staged), 302);
}

async function route(request: Request, url: URL, env: { ASSETS: { fetch: typeof fetch } }, live: LiveContent | undefined): Promise<Response> {
    if (url.pathname === SITEMAP_ALIAS) {
        return Response.redirect(new URL("/sitemap-index.xml", url).href, 301);
    }

    // Checked before the asset layer, so a moved path never hits its would-be 404; the query string rides along.
    const moved = movedPath(url.pathname);
    if (moved !== undefined) {
        return Response.redirect(new URL(`${moved}${url.search}`, url).href, 301);
    }

    const download = DESKTOP_ROUTES[url.pathname.replace(/\/$/, "")];
    if (download !== undefined) {
        return desktopDownload(download, request, url, env, live);
    }

    const canonical = canonicalForMarkdown(url.pathname);
    if (canonical !== undefined) {
        const asset = await env.ASSETS.fetch(request);
        if (asset.status !== 200) {
            return asset;
        }
        return new Response(asset.body, {
            status: asset.status,
            headers: {
                "content-type": "text/markdown; charset=utf-8",
                link: `<${new URL(canonical, url).href}>; rel="canonical"`,
            },
        });
    }

    // Matches vanity paths slash-insensitively; non-vanity requests fall through with the original request.
    const vanity = url.pathname !== "/" && url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;

    // History-mode SPA fallback: serves the demo's document for any /demo/ navigation that misses a real file.
    if (url.pathname.startsWith("/demo") && request.headers.get("accept")?.includes("text/html") === true) {
        const asset = await env.ASSETS.fetch(request);
        return asset.status === 404 ? env.ASSETS.fetch(new Request(new URL("/demo/index.html", url), request)) : asset;
    }

    const file = SCRIPTS[vanity];
    if (file === undefined) {
        return env.ASSETS.fetch(request);
    }
    const asset = await env.ASSETS.fetch(new Request(new URL(`/scripts/${file}`, url), request));
    return new Response(asset.body, { status: asset.status, headers: { "content-type": "text/plain; charset=utf-8" } });
}
