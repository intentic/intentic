// Vanity install-script URLs: https://intentic.dev/connect etc. The monorepo has no public git mirror to
// redirect to, so the connect scripts live in this package's public/scripts/ (tracked site assets) and the
// worker serves them as text/plain so `curl … | sh` gets the raw script. run_worker_first (wrangler.jsonc) sends
// EVERY request here first — otherwise Cloudflare's asset layer answers browser navigations to /connect with the
// 404 page before the worker runs. Non-vanity paths fall through to env.ASSETS.fetch(): the built asset, or the
// 404 page for a real miss.
const SCRIPTS: Record<string, string> = {
    "/connect": "connect.sh",
    "/connect.ps1": "connect.ps1",
    "/connect-host": "connect-host.sh",
    "/connect-host.ps1": "connect-host.ps1",
    "/cleanup-host": "cleanup-host.sh",
    "/sync": "sync.sh",
    "/sync.ps1": "sync.ps1",
    "/cleanup": "cleanup.sh",
    "/cleanup.ps1": "cleanup.ps1",
    // Both vanity paths serve the ONE recreate script — the mode rides the argument shape the platform's
    // cards already hand out (<slug> <sha256> = rebuild, <slug> = update), so every pasted one-liner keeps
    // working across the merge.
    "/rebuild": "recreate.sh",
    "/update": "recreate.sh",
};

// The Markdown mirror of /docs/quickstart/ lives at /docs/quickstart.md and is word-for-word the same
// page, so it needs to say which of the two is the real one. A .md file can't carry <link rel=canonical>,
// so the header does it — otherwise the pair reads as duplicate content.
function canonicalForMarkdown(pathname: string): string | undefined {
    if (!pathname.endsWith(".md")) return undefined;
    const withoutExt = pathname.slice(0, -".md".length);
    return withoutExt === "/index" ? "/" : `${withoutExt}/`;
}

export default {
    async fetch(request: Request, env: { ASSETS: { fetch: typeof fetch } }): Promise<Response> {
        const url = new URL(request.url);

        const canonical = canonicalForMarkdown(url.pathname);
        if (canonical !== undefined) {
            const asset = await env.ASSETS.fetch(request);
            if (asset.status !== 200) return asset;
            return new Response(asset.body, {
                status: asset.status,
                headers: {
                    "content-type": "text/markdown; charset=utf-8",
                    link: `<${new URL(canonical, url).href}>; rel="canonical"`,
                },
            });
        }

        // Match vanity paths slash-insensitively: /connect and /connect/ both serve the script. The site's Astro
        // pages use trailingSlash: "always", so a browser visit can arrive with a slash — but these worker routes
        // aren't Astro pages, so without this a trailing slash would fall through to the 404 page. Non-vanity
        // requests still fall through with the ORIGINAL request, keeping Astro's own slash canonicalization intact.
        const vanity = url.pathname !== "/" && url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
        const file = SCRIPTS[vanity];
        if (file === undefined) {
            return env.ASSETS.fetch(request);
        }
        const asset = await env.ASSETS.fetch(new Request(new URL(`/scripts/${file}`, url), request));
        return new Response(asset.body, { status: asset.status, headers: { "content-type": "text/plain; charset=utf-8" } });
    },
};
