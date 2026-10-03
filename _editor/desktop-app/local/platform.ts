import type { apiContract, SandboxSummary, User } from "@intentic/api-contract";
import type { LocalFace } from "@intentic/web/local";
import type { AccountAnswer, AccountAsk } from "../src/desktop";
import { LOCAL_PLATFORM_ORIGIN } from "./origin";

// The platform's side of what a local window boots on, answered in the page: who is signed in and which sandbox is
// open. The editor asks both before it draws anything (router/index.ts, requireAuth and requireSetup), and a window on
// a folder has neither an account nor a sandbox, so it is told of one person and one "sandbox", the folder itself,
// whose daemon is the app's intentic-files sidecar. Nothing here leaves the page: its origin (origin.ts) does not resolve.
// The account's own calls are the exception (`RELAYED`): the app sends those to the platform, with the workspace's session.

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

// THE ACCOUNT'S CALLS that Settings and the account menu make through the editor's API client: the plan and its
// checkout (useHostedPlan, Billing), API tokens, the data export. They are not the folder's to answer, so the app sends
// them on with the session the workspace signed in with (src-tauri/src/account.rs, whose list decides; this one only
// routes). Who is signed in is not among them: this page's own session check stays the folder's placeholder above, and
// the shell asks for the account through its host (src/host.ts), so a platform that cannot be reached never holds the
// window's first paint.
const RELAYED: ReadonlySet<string> = new Set([
    `/rpc/hosted-plan`,
    `/rpc/hosted-plan/slots`,
    `/rpc/hosted-plan/tier`,
    `/rpc/hosted-plan/checkout`,
    `/rpc/hosted-plan/portal`,
    `/rpc/tokens`,
    `/rpc/tokens/create`,
    `/rpc/tokens/revoke`,
    `/rpc/me/export`,
]);

export type PlatformRelay = (ask: AccountAsk) => Promise<AccountAnswer>;

// Statuses a Response must be built without a body for.
const BODILESS: ReadonlySet<number> = new Set([101, 204, 205, 304]);

// One of those calls as the app carries it, and its answer as the fetch that asked would have had it. A platform the
// app cannot reach rejects, as a fetch does.
const relayed = async (relay: PlatformRelay, request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const text = request.method === `POST` ? await request.text() : ``;
    const ask: AccountAsk = { method: request.method === `POST` ? `POST` : `GET`, path: `${url.pathname}${url.search}` };
    const answer = await relay(text === `` ? ask : { ...ask, body: text });
    const headers: Record<string, string> = answer.contentType === null ? {} : { "content-type": answer.contentType };
    return new Response(BODILESS.has(answer.status) ? null : answer.body, { status: answer.status, headers });
};

const isRelayed = (url: URL, method: string): boolean => RELAYED.has(url.pathname) && (method === `GET` || method === `POST`);

// Routes the page's platform calls to the answers above, the account's own through `relay` where the app is there to
// carry them; every other request goes where it was going.
export const installPlatform = (face: LocalFace, relay?: PlatformRelay): void => {
    const original = globalThis.fetch;
    const passThrough = original.bind(globalThis);
    const routed = (...[input, init]: Parameters<typeof fetch>): Promise<Response> => {
        const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
        if (url.origin !== LOCAL_PLATFORM_ORIGIN) {
            return passThrough(input, init);
        }
        // The editor's API client asks with a Request and options beside it (`credentials`), which a new Request merges.
        const method = (init?.method ?? (input instanceof Request ? input.method : `GET`)).toUpperCase();
        if (relay === undefined || !isRelayed(url, method)) {
            return Promise.resolve(platformAnswer(face, url));
        }
        return relayed(relay, input instanceof Request ? new Request(input, init) : new Request(url, init));
    };
    // Whatever the runtime hangs on its fetch (bun's `preconnect`, where the tests run) stays on the one replacing it.
    globalThis.fetch = Object.assign(routed, original);
};
