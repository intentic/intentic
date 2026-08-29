import { INSTALL_SCRIPTS } from "@intentic/constants";
import { DESKTOP_ROUTES, RELEASES_URL } from "./src/lib/desktop-downloads";

/* Vanity install-script URLs: https://intentic.dev/connect etc. The monorepo has no public git mirror to
 * redirect to, so the connect scripts live in this package's public/scripts/ (tracked site assets) and the
 * worker serves them as text/plain so `curl … | sh` gets the raw script. run_worker_first (wrangler.jsonc) sends
 * EVERY request here first, otherwise Cloudflare's asset layer answers browser navigations to /connect with the
 * 404 page before the worker runs. Non-vanity paths fall through to env.ASSETS.fetch(): the built asset, or the
 * 404 page for a real miss.
 *
 * The table is @intentic/constants' (INSTALL_SCRIPTS), because the app WRITES these URLs into the one-liners
 * it hands out and this worker is what answers them. Two hand-synced lists in two packages meant a renamed
 * script served the 404 page into somebody's `sh`. Both vanity paths for the recreate script survive the
 * merge there: the mode rides the argument shape the platform's cards already hand out. */
const SCRIPTS: Record<string, string> = Object.fromEntries(Object.values(INSTALL_SCRIPTS).map((script) => [script.path, script.file]));

/* Paths that moved, kept alive as 301s. The site's menu labels and its URLs used to disagree: "Features" over
 * /product/, "Run" over /product/orchestrate/. The labels were the accurate half, so the paths moved to match
 * them.
 *
 * These are the ONE compatibility layer this repo keeps, and the reason is that a URL is the only thing here
 * somebody else has already written down: in a bookmark, a blog post, an answer on a forum, a search index.
 * We can update every link we own in one commit and none of the links we don't. A 301 is also what tells a
 * search engine to move the ranking rather than split it, which is the difference between a rename and a
 * quiet traffic loss.
 *
 * /api IS NO LONGER FORWARDED, and it is the one entry that has been withdrawn rather than kept. It used to
 * send /api/* to /developers/*, from when the authoring book lived there. /api/ is now a real book of its own:
 * the daemon's whole HTTP surface, generated from the contract. A forward would have to shadow it, so the two
 * cannot both exist, and of the two the live reference is worth more than the redirect.
 *
 * The old deep links that break are /api/, /api/manifest, /api/host, /api/build, /api/publish, /api/verify,
 * /api/maintain and /api/services. Six of the eight now 404; the other two, /api/host and a bare /api/, land on
 * pages about something else, which is the sharper edge of this. It is accepted deliberately: those paths were
 * themselves a forward that had already been in place since the rename, so anything still using them has had a
 * redirect the whole time and never followed it.
 *
 * The verb map is spelled out rather than derived from productPages: it is the OLD vocabulary, which by
 * definition no longer appears in the content. Automate kept its name and so needs no entry.
 *
 * /product is handled as a prefix, so every page under it, including any added later, and any deep link with a
 * #fragment, follows without a new line here. */
const MOVED_VERBS: Record<string, string> = {
    orchestrate: "run",
    empower: "connect",
    supervise: "review",
    delegate: "host",
};

/* Pages that moved to a different book, matched exactly rather than by prefix. One entry so far: the prose
 * page that stood in for a route reference until there was a generated one. Its readers were arriving with a
 * specific question, so the pages that used to link to it now link into /api/ at the page that answers each,
 * and this catches the addresses somebody else wrote down. */
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
    // Astro builds with trailingSlash: "always", so a moved page has to land on the slashed form or the asset
    // layer answers with the 404 page. Real files (the .md mirrors, llms.txt) keep their exact name instead.
    return /\.[a-z0-9]+$/iu.test(moved) || moved.endsWith("/") ? moved : `${moved}/`;
}

/* HSTS, on every https response. It is the half of protocol canonicalization the redirect below cannot do:
 * a 301 fixes the request that already went out in the clear, this stops the next one being made at all, so
 * a returning visitor never issues the plaintext hop a redirect has to answer.
 *
 * includeSubDomains is safe here and checked: app. and api. both terminate TLS. `preload` is deliberately
 * NOT set, that submits the domain to a list baked into browser binaries, and getting off it takes months.
 * A year of max-age is the value the preload list would want anyway if we ever chose to. */
const HSTS = "max-age=31536000; includeSubDomains";

/* Where a sitemap lives, and where naive tools look for it. robots.txt names /sitemap-index.xml and that is
 * the real document; /sitemap.xml is the filename half the tooling in the world guesses at without asking.
 * A 301 costs nothing and turns a 404 in somebody's crawler into the file they were after. */
const SITEMAP_ALIAS = "/sitemap.xml";

// The Markdown mirror of /docs/quickstart/ lives at /docs/quickstart.md and is word-for-word the same
// page, so it needs to say which of the two is the real one. A .md file can't carry <link rel=canonical>,
// so the header does it, otherwise the pair reads as duplicate content.
function canonicalForMarkdown(pathname: string): string | undefined {
    if (!pathname.endsWith(".md")) {
        return undefined;
    }
    const withoutExt = pathname.slice(0, -".md".length);
    return withoutExt === "/index" ? "/" : `${withoutExt}/`;
}

/* Desktop-app downloads (_editor/desktop-app): stable vanity URLs, so the site and the app's own links never
 * carry a version, while the FILE they hand over does. Those are two different promises and this is where
 * they are kept apart: a link that needs bumping every release eventually 404s, and a download called
 * `Intentic-setup.exe` cannot tell anyone which build they installed, or survive sitting in a Downloads
 * folder beside three of its own predecessors.
 *
 * An installer staged locally into public/desktop/ (stage-local-downloads.sh, gitignored, so a deploy
 * normally ships none) is served directly under its plain staged name; otherwise this resolves the newest
 * release and redirects to that release's versioned asset.
 *
 * The path table is shared with the dev server, which stands in for this worker locally (astro.config.mjs). */

/* Where a download route actually sends someone, memoised per platform for an hour in the isolate. A worker
 * isolate serves many requests, so the common case costs no upstream request at all; a cold or recycled
 * isolate simply asks again. Releases are the slowest-moving thing this site knows about, and being an hour
 * behind on one costs a visitor nothing, the previous version's asset is still there.
 *
 * TWO upstream reads, both cheap and both headers-only:
 *
 *   1. WHICH RELEASE IS NEWEST, read from where GitHub already answers it: /releases/latest is a 302 to
 *      /releases/tag/v<version>. Not the REST API, that spends an unauthenticated quota shared across
 *      everything leaving a Cloudflare colo, for a fact this redirect states in a response with no body.
 *   2. WHETHER THAT RELEASE REALLY CARRIES THIS ASSET. Composing a file name from a version is a guess about
 *      what a build produced, and this route is the main way anyone gets the product, so the guess is
 *      checked rather than served. It covers a release that failed to attach one platform's installer, a
 *      naming change landing on the site before the first release that produces it, and any future rename
 *      whose two halves deploy at different times, because the site and the release pipeline are separate
 *      deployments and always will be.
 *
 * A miss falls back to the releases page: not the file they asked for, but a page with every asset on it and
 * a working download two seconds away. A dead end is the one answer this route must never give. */
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

/* THE PROTOCOL, DECIDED ONCE. Cloudflare serves this site on both schemes, so until this existed every page
 * had a plaintext twin that answered 200 and carried the same self-referencing canonical, two crawlable
 * copies of one site, splitting the links and the crawl signals between them. Google had already indexed the
 * http:// homepage under a title we retired.
 *
 * ONE 301, NEVER TWO. The scheme is swapped on the parsed URL, so host, query and port survive untouched, and
 * a path that also MOVED is resolved in the same response rather than in a second one: http://…/api/host/ goes
 * straight to https://…/developers/host/, not to its own plaintext twin first. Two redirects for one request
 * is the chain the audit warned about, and legacy paths are exactly the URLs old enough to still be written
 * down as http:// somewhere. */
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

        const response = await route(request, url, env);
        // Header sets are immutable on a response that came from fetch(), so this is a copy either way.
        const headers = new Headers(response.headers);
        headers.set("strict-transport-security", HSTS);
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    },
};

async function route(request: Request, url: URL, env: { ASSETS: { fetch: typeof fetch } }): Promise<Response> {
    if (url.pathname === SITEMAP_ALIAS) {
        return Response.redirect(new URL("/sitemap-index.xml", url).href, 301);
    }

    // Before anything else: a request for a path that moved never reaches the asset layer, which would
    // answer it with the 404 page. The query string rides along; the fragment never left the browser.
    const moved = movedPath(url.pathname);
    if (moved !== undefined) {
        return Response.redirect(new URL(`${moved}${url.search}`, url).href, 301);
    }

    const download = DESKTOP_ROUTES[url.pathname.replace(/\/$/, "")];
    if (download !== undefined) {
        const staged = await env.ASSETS.fetch(new Request(new URL(`/desktop/${download.staged}`, url), request));
        if (staged.ok) {
            const headers = new Headers(staged.headers);
            headers.set("content-disposition", `attachment; filename="${download.staged}"`);
            return new Response(staged.body, { status: staged.status, headers });
        }
        // Keyed on the staged name rather than the route, so /desktop and /desktop/windows, the same
        // installer under two paths, share one resolution instead of probing for it twice.
        return Response.redirect(await resolveDownload(download.asset, download.staged), 302);
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

    // Match vanity paths slash-insensitively: /connect and /connect/ both serve the script. The site's Astro
    // pages use trailingSlash: "always", so a browser visit can arrive with a slash, but these worker routes
    // aren't Astro pages, so without this a trailing slash would fall through to the 404 page. Non-vanity
    // requests still fall through with the ORIGINAL request, keeping Astro's own slash canonicalization intact.
    const vanity = url.pathname !== "/" && url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;

    /* The interactive demo (@intentic-dev/demo, built into public/demo/) is a history-mode SPA sharing this
     * origin, so its routes: /demo/agents, /demo/workspace/api/src/stripe.ts, are paths no asset answers.
     * Serve its document for any navigation under /demo/ that isn't a real file, which is the same rule its
     * dev server runs. Keyed on the request wanting html: a workspace route legitimately ends in `.ts`, and
     * the demo's own chunks never ask for a document. */
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
