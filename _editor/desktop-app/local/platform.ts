import type { apiContract, SandboxSummary, User } from "@intentic/api-contract";
import type { LocalFace } from "@intentic/web/local";
import { LOCAL_PLATFORM_ORIGIN } from "./origin";

// The platform's side of what a local window boots on, answered in the page: who is signed in and which sandbox is
// open. The editor asks both before it draws anything (router/index.ts, requireAuth and requireSetup), and a window on
// a folder has neither an account nor a sandbox, so it is told of one person and one "sandbox", the folder itself,
// whose daemon is the app's intentic-files sidecar. Nothing here leaves the page: its origin (origin.ts) does not resolve.

// What a platform procedure answers, read off the contract's own output schema through the Standard Schema type slot
// (the one oRPC infers from), so an answer below that drifts from the contract fails the type check, not the window.
type StandardOutput<Schema> = Schema extends { readonly "~standard": { readonly types?: infer Types } }
    ? NonNullable<Types> extends { readonly output: infer Output }
        ? Output
        : never
    : never;
export type OutputOf<Procedure extends { readonly "~orpc": { readonly outputSchema?: unknown } }> = StandardOutput<
    NonNullable<Procedure["~orpc"]["outputSchema"]>
>;

// GET /api/auth/get-session, as the editor reads it (_editor/web/src/features/auth/useAuth.ts, `refresh`): better-auth's
// client hands the body back unvalidated, and the reader takes only `user`, into the contract's User. better-auth's own
// session type is the editor's dependency and out of this package's reach, so this names what its server sends that
// the reader or its client looks at, and no more.
export interface LocalSession {
    readonly session: { readonly id: string; readonly userId: string; readonly expiresAt: string };
    readonly user: User;
}

// Nobody signs in to a folder; the editor still needs someone to be, and a session is only whole with an address in it.
// A well-formed one, since the contract's User requires it; `.invalid` is no mailbox anyone has.
export const LOCAL_EMAIL = `you@this-computer.invalid`;
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

const sessionOf = (): LocalSession => ({
    session: { id: `local`, userId: LOCAL_USER.id, expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString() },
    user: LOCAL_USER,
});

export const platformAnswer = (face: LocalFace, url: URL): Response => {
    if (url.pathname.startsWith(`/api/auth/`)) {
        // Only get-session is read; any other auth call must not 404, or the client reads it as signed out.
        return url.pathname.endsWith(`/get-session`) ? json(sessionOf()) : json({ ok: true });
    }
    switch (url.pathname) {
        case `/rpc/sandbox/list`:
            return json<OutputOf<typeof apiContract.sandbox.list>>({ sandboxes: [rowOf(face)] });
        case `/rpc/sandbox/trash`:
            return json<OutputOf<typeof apiContract.sandbox.trash>>({ sandboxes: [] });
        case `/rpc/me`:
            return json<OutputOf<typeof apiContract.me.get>>(LOCAL_USER);
        default:
            return json({ message: `A local folder has no account behind it.` }, 404);
    }
};

// Routes the page's platform calls to the answers above; every other request goes where it was going.
export const installPlatform = (face: LocalFace): void => {
    const original = globalThis.fetch;
    const passThrough = original.bind(globalThis);
    const routed = (...[input, init]: Parameters<typeof fetch>): Promise<Response> => {
        const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
        return url.origin === LOCAL_PLATFORM_ORIGIN ? Promise.resolve(platformAnswer(face, url)) : passThrough(input, init);
    };
    // Whatever the runtime hangs on its fetch (bun's `preconnect`, where the tests run) stays on the one replacing it.
    globalThis.fetch = Object.assign(routed, original);
};
