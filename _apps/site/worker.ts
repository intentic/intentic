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

// Desktop-app downloads: stable vanity URLs. A locally-staged installer in public/desktop/ (see
// _apps/desktop/scripts/stage-local-downloads.sh — gitignored, so deploys normally ship none) is
// served directly; otherwise redirect to the newest release's asset (the same permalink convention
// sync.sh uses for its binaries). Names match release-build.sh's un-versioned artifact names so
// nothing here ever needs a version bump.
const RELEASE_DOWNLOADS = "https://gitlab.com/radarsu/intentic/-/releases/permalink/latest/downloads";
const DESKTOP_FILES: Record<string, string> = {
    "/desktop": "Intentic-setup.exe",
    "/desktop/windows": "Intentic-setup.exe",
    "/desktop/linux": "Intentic.AppImage",
    "/desktop/deb": "Intentic.deb",
    "/desktop/rpm": "Intentic.rpm",
};

export default {
    async fetch(request: Request, env: { ASSETS: { fetch: typeof fetch } }): Promise<Response> {
        const url = new URL(request.url);
        const download = DESKTOP_FILES[url.pathname];
        if (download !== undefined) {
            const staged = await env.ASSETS.fetch(new Request(new URL(`/desktop/${download}`, url), request));
            if (staged.ok) {
                const headers = new Headers(staged.headers);
                headers.set("content-disposition", `attachment; filename="${download}"`);
                return new Response(staged.body, { status: staged.status, headers });
            }
            return Response.redirect(`${RELEASE_DOWNLOADS}/desktop/${download}`, 302);
        }
        const file = SCRIPTS[url.pathname];
        if (file === undefined) {
            return env.ASSETS.fetch(request);
        }
        const asset = await env.ASSETS.fetch(new Request(new URL(`/scripts/${file}`, url), request));
        return new Response(asset.body, { status: asset.status, headers: { "content-type": "text/plain; charset=utf-8" } });
    },
};
