import type { apiContract, SandboxSummary, User } from "@intentic/api-contract";
import type { LocalSession, OutputOf } from "./platform";

// THE SANDBOX FACE (2026-10-16): the whole editor, from the app's own bundle, on THIS MACHINE's sandboxes, for when the
// internet is out. The workspace window loads the editor from app.intentic.dev, and the editor asks the platform who is
// signed in and which sandboxes there are before it draws anything; with no network neither answers. This face is the
// same editor (every route and extension, unlike the folder face, local/main.ts) with those two questions answered in
// the page from what the app knows: the account the workspace last told it (roster.json) and the sandboxes `ic sandbox
// list --json` lists here, each reached on its loopback port with a session the machine minted for its owner (`ic
// sandbox session`, the daemon's auth/host/host-session.ts). Nothing here reaches a server of ours: the stand-in's origin
// (origin.ts) does not resolve, and whatever needs the platform (billing, sharing, tokens, a new sandbox) is answered in
// plain words that it needs the internet.

// What the app hands the page (machine_face.rs `MachineFace`): who, which sandboxes, and where the online editor is.
export interface MachineFace {
    // The account the workspace last named (roster.json); null on a machine whose workspace never signed in, where the
    // first session's owner stands in.
    readonly account: { readonly email: string; readonly name: string | null; readonly image: string | null } | null;
    readonly sandboxes: readonly MachineSandbox[];
    // The online editor's address, to go back to when it answers again.
    readonly appUrl: string;
}

export interface MachineSandbox {
    readonly slug: string;
    readonly name: string;
    // The platform's id for its row, when its announce said one (the editor keys everything by it); else null.
    readonly platformId: string | null;
    // Its 12-hex id, from its connect token; null for a container that has none.
    readonly sandboxId: string | null;
    readonly localPort: number | null;
    readonly running: boolean;
    readonly asleep: boolean;
    // A session the machine minted for its owner; null for one asleep, stopped, or that refused (nobody signed in yet).
    readonly session: { readonly token: string; readonly expiresAt: number; readonly email: string } | null;
    // Why there is no session, in the reader's words, when one was asked for and refused.
    readonly why: string | null;
}

// The id the editor knows a sandbox by here: the platform's, so tabs and drafts kept under it are the same sandbox's
// when the workspace comes back; a sandbox the platform never named is this machine's by its own id.
export const sandboxKeyOf = (sandbox: Pick<MachineSandbox, "platformId" | "sandboxId" | "slug">): string =>
    sandbox.platformId ?? `machine-${sandbox.sandboxId ?? sandbox.slug}`;

// The sandboxes a page can open: each one with a loopback port to dial. Without one there is nowhere to send a call.
const reachable = (face: MachineFace): readonly MachineSandbox[] => face.sandboxes.filter((sandbox) => sandbox.localPort !== null);

// A sandbox as the platform's list row would describe it, pointed at its loopback port. No connect token: the editor
// dials the row's address as is (endpoint.ts), and the session seeded for it is what opens it. A last-seen time only
// for one running now, since an epoch one reads as a setup still to finish (router/setupGate.ts).
const rowOf = (sandbox: MachineSandbox, now: Date): SandboxSummary => ({
    id: sandboxKeyOf(sandbox),
    name: sandbox.name,
    image: null,
    daemonUrl: `http://127.0.0.1:${String(sandbox.localPort)}`,
    lastSeenAt: now.toISOString(),
    setupCodeClaimedAt: null,
    setupReport: null,
    bootReport: null,
    announceRefusal: null,
    removedAt: null,
    removedBy: null,
    token: null,
    role: `owner`,
    providedAddress: false,
    localHostname: null,
    hosted: null,
});

export const rowsOf = (face: MachineFace, now: Date): readonly SandboxSummary[] => reachable(face).map((sandbox) => rowOf(sandbox, now));

// Who the page runs as: the account the workspace last named, else the owner a session was minted for, else a
// placeholder, since the editor needs somebody and a session is only whole with an address in it.
export const MACHINE_EMAIL = `you@this-computer.invalid`;
export const userOf = (face: MachineFace): User => {
    const email = face.account?.email ?? face.sandboxes.find((sandbox) => sandbox.session !== null)?.session?.email ?? MACHINE_EMAIL;
    return { id: `machine:${email}`, email, name: face.account?.name ?? ``, image: face.account?.image ?? null };
};

const json = <Body>(body: Body, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": `application/json` } });

const sessionOf = (face: MachineFace, now: Date): LocalSession => {
    const user = userOf(face);
    return { session: { id: `machine`, userId: user.id, expiresAt: new Date(now.getTime() + 86_400_000).toISOString() }, user };
};

// What anything that needs the platform answers, in the reader's words: the editor shows a refusal's `message`.
export const NEEDS_INTERNET = `This needs the internet. Your sandboxes on this computer keep working; this part comes back when the internet does.`;

export const machinePlatformAnswer = (face: MachineFace, url: URL, now: Date = new Date()): Response => {
    if (url.pathname.startsWith(`/api/auth/`)) {
        // Only get-session is read; any other auth call must not 404, or the client reads it as signed out.
        return url.pathname.endsWith(`/get-session`) ? json(sessionOf(face, now)) : json({ ok: true });
    }
    switch (url.pathname) {
        case `/rpc/sandbox/list`:
            return json<OutputOf<typeof apiContract.sandbox.list>>({ sandboxes: [...rowsOf(face, now)] });
        case `/rpc/sandbox/trash`:
            return json<OutputOf<typeof apiContract.sandbox.trash>>({ sandboxes: [] });
        case `/rpc/me`:
            return json<OutputOf<typeof apiContract.me.get>>(userOf(face));
        default:
            // 503, not 404: the platform is not there, which is not the same as a thing that does not exist.
            return json({ message: NEEDS_INTERNET }, 503);
    }
};

// Routes the page's platform calls (to `platformOrigin`) to the answers above; every other request goes where it was
// going, the loopback daemons' included.
export const installMachinePlatform = (face: () => MachineFace, platformOrigin: string): void => {
    const original = globalThis.fetch;
    const passThrough = original.bind(globalThis);
    const routed = (...[input, init]: Parameters<typeof fetch>): Promise<Response> => {
        const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
        return url.origin === platformOrigin ? Promise.resolve(machinePlatformAnswer(face(), url)) : passThrough(input, init);
    };
    // Whatever the runtime hangs on its fetch (bun's `preconnect`, where the tests run) stays on the one replacing it.
    globalThis.fetch = Object.assign(routed, original);
};

// Each minted session where the editor's sandbox client reads one (`intentic.session.<id>`, sandboxSession.ts), and the
// loopback shortcut's question answered: the row's address is the loopback already. A sandbox without a session keeps
// whatever this page held for it before (a session still good from an earlier offline spell). Answers the ids seeded.
export const seedSessions = (face: MachineFace, storage: Pick<Storage, `setItem`>): readonly string[] =>
    reachable(face).flatMap((sandbox) => {
        const id = sandboxKeyOf(sandbox);
        storage.setItem(`intentic.localShortcut.declined.${id}`, `yes`);
        if (sandbox.session === null) {
            return [];
        }
        storage.setItem(`intentic.session.${id}`, JSON.stringify(sandbox.session));
        return [id];
    });

// The sandbox the page opens on: the one it was on, while this machine still has it, else the first running one with a
// session, else the first listed.
export const openingSandbox = (face: MachineFace, previous: string | null): string | undefined => {
    const listed = reachable(face);
    if (previous !== null && listed.some((sandbox) => sandboxKeyOf(sandbox) === previous)) {
        return previous;
    }
    const first = listed.find((sandbox) => sandbox.running && sandbox.session !== null) ?? listed[0];
    return first === undefined ? undefined : sandboxKeyOf(first);
};
