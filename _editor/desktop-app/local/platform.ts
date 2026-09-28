import type { SandboxSummary, User } from "@intentic/api-contract";
import type { LocalFace } from "@intentic/web/local";

// The platform's side of what a local window boots on, answered in the page: who is signed in and which sandbox is
// open. The editor asks both before it draws anything (router/index.ts, requireAuth and requireSetup), and a window on
// a folder has neither an account nor a sandbox, so it is told of one person and one "sandbox", the folder itself,
// whose daemon is the app's intentic-files sidecar. Nothing here leaves the page: the origin below does not resolve.

export const LOCAL_PLATFORM_ORIGIN = `https://platform.local.invalid`;

// Nobody signs in to a folder; the editor still needs someone to be, and a session is only whole with an address in it.
export const LOCAL_EMAIL = `you@this-computer`;
const LOCAL_USER: User = { id: `local`, email: LOCAL_EMAIL, name: ``, image: null };

export const sandboxIdOf = (face: LocalFace): string => `local-${face.id}`;

const rowOf = (face: LocalFace): SandboxSummary => ({
    id: sandboxIdOf(face),
    name: face.name,
    image: null,
    daemonUrl: face.daemonUrl,
    lastSeenAt: new Date().toISOString(),
    setupCodeClaimedAt: null,
    setupReport: null,
    bootReport: null,
    announceRefusal: null,
    removedAt: null,
    removedBy: null,
    // No connect token: the editor checks one against the daemon's /health before trusting a loopback address, and the
    // sidecar serves every window from one port, so the window's bearer is what tells them apart.
    token: null,
    // The folder is the person's own: they read and write it with their own rights.
    role: `owner`,
    providedAddress: false,
    localHostname: null,
    hosted: null,
});

const json = <Body>(body: Body, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": `application/json` } });

export const platformAnswer = (face: LocalFace, url: URL): Response => {
    if (url.pathname.startsWith(`/api/auth/`)) {
        // Only get-session is read; any other auth call must not 404, or the client reads it as signed out.
        return json(
            url.pathname.endsWith(`/get-session`)
                ? { session: { id: `local`, userId: LOCAL_USER.id, expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString() }, user: LOCAL_USER }
                : { ok: true },
        );
    }
    switch (url.pathname) {
        case `/rpc/sandbox/list`:
            return json({ sandboxes: [rowOf(face)] });
        case `/rpc/sandbox/trash`:
            return json({ sandboxes: [] });
        case `/rpc/me`:
            return json(LOCAL_USER);
        default:
            return json({ message: `A local folder has no account behind it.` }, 404);
    }
};

// Routes the page's platform calls to the answers above; every other request goes where it was going.
export const installPlatform = (face: LocalFace): void => {
    const passThrough = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
        return url.origin === LOCAL_PLATFORM_ORIGIN ? Promise.resolve(platformAnswer(face, url)) : passThrough(input, init);
    };
};
