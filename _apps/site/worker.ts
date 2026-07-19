// Vanity install-script URLs: https://intentic.dev/connect etc. The monorepo has no public git mirror to
// redirect to, so the connect scripts live in this package's public/scripts/ (tracked site assets) and the
// worker serves them as text/plain so `curl … | sh` gets the raw script. With an assets binding, requests
// matching a built asset are served directly and never reach this worker; everything else lands here and
// falls through to the 404-page via ASSETS.
const SCRIPTS: Record<string, string> = {
    "/connect": "connect.sh",
    "/connect.ps1": "connect.ps1",
    "/connect-host": "connect-host.sh",
    "/connect-host.ps1": "connect-host.ps1",
    "/sync": "sync.sh",
    "/sync.ps1": "sync.ps1",
    "/cleanup": "cleanup.sh",
    "/cleanup.ps1": "cleanup.ps1",
    "/rebuild": "rebuild.sh",
    "/update": "update.sh",
};

// Desktop-app downloads: stable vanity URLs redirecting to the newest release's assets (the same
// permalink convention sync.sh uses for its binaries). Names match release-build.sh's un-versioned
// artifact names so these never need a bump.
const RELEASE_DOWNLOADS = "https://gitlab.com/radarsu/intentic/-/releases/permalink/latest/downloads";
const DESKTOP_DOWNLOADS: Record<string, string> = {
    "/desktop": `${RELEASE_DOWNLOADS}/desktop/Intentic-setup.exe`,
    "/desktop/windows": `${RELEASE_DOWNLOADS}/desktop/Intentic-setup.exe`,
    "/desktop/linux": `${RELEASE_DOWNLOADS}/desktop/Intentic.AppImage`,
    "/desktop/deb": `${RELEASE_DOWNLOADS}/desktop/Intentic.deb`,
    "/desktop/rpm": `${RELEASE_DOWNLOADS}/desktop/Intentic.rpm`,
};

export default {
    async fetch(request: Request, env: { ASSETS: { fetch: typeof fetch } }): Promise<Response> {
        const url = new URL(request.url);
        const download = DESKTOP_DOWNLOADS[url.pathname];
        if (download !== undefined) {
            return Response.redirect(download, 302);
        }
        const file = SCRIPTS[url.pathname];
        if (file === undefined) {
            return env.ASSETS.fetch(request);
        }
        const asset = await env.ASSETS.fetch(new Request(new URL(`/scripts/${file}`, url), request));
        return new Response(asset.body, { status: asset.status, headers: { "content-type": "text/plain; charset=utf-8" } });
    },
};
