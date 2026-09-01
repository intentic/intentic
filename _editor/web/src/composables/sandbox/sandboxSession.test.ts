import { afterEach, beforeEach, expect, it, vi } from "vitest";
// Statically imported for its LOAD COST alone: every test re-imports it through `load()` below, and the first
// of those used to pull the whole graph (useEndpoint, the storage layer, vue) inside the first test's 20s
// budget: ~0.6s idle, but ten times that on a runner where every core is busy, which is how this file failed
// with the first test timing out and the other eleven passing in a second each. Collection is bounded by the
// run rather than by a test, so paying it here costs the same and can't time anything out. Nothing is bound:
// `load()` resets the module registry and re-executes the (already transformed) graph fresh for each test.
// oxlint-disable-next-line import/no-unassigned-import -- imported for its load cost alone, not for a binding
import "./sandboxSession";

/* useSandboxSession decides which bearer a daemon call presents. The contract under test: a valid stored
 * session needs neither Google nor the network; establishing one is a single shared Google mint + exchange;
 * a daemon that refuses the exchange fails loudly rather than degrading to the raw ID token; renewal happens
 * in the background with the session itself. */

const state = vi.hoisted(() => ({
    idToken: `id-token` as string | undefined,
    /* A proof ALREADY IN HAND, which is the whole of what a background reader may spend. Google's own layer
     * serves its cached token without any UI and mints a new one with plenty (One Tap, then the app's gate), so
     * the two are separate answers here rather than one token behind a counter. Undefined by default: the
     * interesting case is the browser whose ~1h proof has aged out, which is every refresh after an hour. */
    cachedIdToken: undefined as string | undefined,
    minted: 0,
    // Whether the daemon this establishment is aimed at is answering its /health at all. A sign-in must never be
    // asked for on behalf of a machine that is switched off.
    daemonAnswers: true,
    // What the Google layer was ASKED to do with the credential: a session rejection must never reach either.
    cleared: 0,
    canceled: 0,
    sandboxId: `sb-1` as string | undefined,
    /* A mint that does not resolve: what a real one does while Google's prompt (or the app's own gate) is up
     * and the reader has not answered it. The state a switch has to be able to leave behind.
     *
     * Released in afterEach, because `load()` resets the module registry but the mocked useSandbox is
     * evaluated once for the file: every previously-loaded copy of the module still watches that same ref, so
     * a parked establish left in one of THEIR `inflight` maps answers the next test's switch as well. */
    mintParks: false,
    releaseMint: (): void => {},
    // Points the workspace at another sandbox the way the switcher does, through the ref the module watches.
    // Bound by the useSandbox mock's factory, which vitest evaluates once for the file.
    select: (_id: string | undefined): void => {},
}));

vi.mock("../useGoogleIdentity", () => ({
    useGoogleIdentity: () => ({
        getIdToken: async (options?: { interactive?: boolean }) => {
            // `interactive: false` is a caller with no standing to interrupt: it gets what Google can hand over
            // in silence, and nothing at all otherwise. No prompt, so nothing to count and nothing to park on.
            if (options?.interactive === false) {
                return state.cachedIdToken;
            }
            state.minted += 1;
            if (!state.mintParks) {
                return state.idToken;
            }
            return new Promise<string | undefined>((resolve) => {
                state.releaseMint = () => resolve(undefined);
            });
        },
        signedInEmail: { value: `google@x.com` },
        clearCredential: () => {
            state.cleared += 1;
        },
        cancelSignIn: () => {
            state.canceled += 1;
        },
    }),
}));
/* The reachability question this module asks before it asks a PERSON for anything, stubbed at the seam rather
 * than through a /health response: endpoint.ts owns that check and tests it there, and what matters here is
 * only the answer it gives back. Everything else in the module is the real thing, since the target resolution
 * underneath these tests rides on it. */
vi.mock("./endpoint", async () => ({
    ...(await vi.importActual<typeof import("./endpoint")>(`./endpoint`)),
    healthAnswers: async () => state.daemonAnswers,
    sandboxIdOf: async () => `sb-1`,
}));
// A real ref, not a getter: the module WATCHES the active sandbox (a switch settles a mint left parked for the
// sandbox being left), and a watch source has to be one.
vi.mock("./useSandbox", async () => {
    const { computed, ref } = await vi.importActual<typeof import("vue")>(`vue`);
    const activeSandboxId = ref(state.sandboxId);
    state.select = (id) => {
        activeSandboxId.value = id;
    };
    return {
        useSandbox: () => ({
            active: computed(() => (activeSandboxId.value === undefined ? undefined : { id: activeSandboxId.value, token: `connect` })),
            activeSandboxId,
            daemonUrl: { value: `https://daemon.test` },
        }),
    };
});
// Storage stub for the node test environment: the standard Storage surface, backed by a Map.
const stubStorage = (): void => {
    const map = new Map<string, string>();
    vi.stubGlobal(`localStorage`, {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => void map.set(key, value),
        removeItem: (key: string) => void map.delete(key),
        clear: () => map.clear(),
        key: (index: number) => [...map.keys()][index] ?? null,
        get length() {
            return map.size;
        },
    });
};

const DAY_MS = 24 * 60 * 60 * 1000;
const session = (overrides?: Partial<{ token: string; expiresAt: number; email: string }>): string =>
    JSON.stringify({ token: `sess-stored`, expiresAt: Date.now() + 30 * DAY_MS, email: `o@x.com`, ...overrides });

const sessionResponse = (token = `sess-minted`): Response =>
    new Response(JSON.stringify({ token, expiresAt: Date.now() + 30 * DAY_MS, email: `o@x.com` }), {
        status: 200,
        headers: { "content-type": `application/json` },
    });

// Fresh module per test: the singleton carries the in-memory session mirror.
const load = async (): Promise<typeof import("./sandboxSession")> => {
    vi.resetModules();
    return import("./sandboxSession");
};

beforeEach(() => {
    stubStorage();
    state.idToken = `id-token`;
    state.cachedIdToken = undefined;
    state.daemonAnswers = true;
    state.minted = 0;
    state.cleared = 0;
    state.canceled = 0;
    state.sandboxId = `sb-1`;
    state.mintParks = false;
    // The active-sandbox ref lives in the mock factory, which vitest evaluates once for the whole file, so it
    // survives `load()`'s module reset: a test that switches sandboxes has to hand it back.
    state.select(`sb-1`);
});
afterEach(async () => {
    state.releaseMint();
    state.releaseMint = () => {};
    // One turn for the released establish to fall out of its module's `inflight`.
    await new Promise((resolve) => setTimeout(resolve));
    vi.unstubAllGlobals();
});

it(`serves a valid stored session with no Google mint and no network`, async () => {
    localStorage.setItem(`intentic.session.sb-1`, session());
    const fetchMock = vi.fn();
    vi.stubGlobal(`fetch`, fetchMock);
    const { useSandboxSession } = await load();
    expect(await useSandboxSession().getSessionToken()).toEqual({ token: `sess-stored`, kind: `session` });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.minted).toBe(0);
});

it(`establishes a session from a Google proof: one exchange, persisted, then served from cache`, async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => sessionResponse());
    vi.stubGlobal(`fetch`, fetchMock);
    const { useSandboxSession } = await load();
    expect(await useSandboxSession().getSessionToken()).toEqual({ token: `sess-minted`, kind: `session` });
    // The exchange call: the daemon's session route, the Google bearer, the TOFU connect token.
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://daemon.test/system/session`);
    expect(init.headers).toMatchObject({ authorization: `Bearer id-token`, "x-intentic-connect": `connect` });
    expect(JSON.parse(localStorage.getItem(`intentic.session.sb-1`) ?? ``)).toMatchObject({ token: `sess-minted`, email: `o@x.com` });
    // Steady state: the second call touches nothing.
    expect(await useSandboxSession().getSessionToken()).toEqual({ token: `sess-minted`, kind: `session` });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.minted).toBe(1);
});

it(`shares one in-flight establish across concurrent calls`, async () => {
    const fetchMock = vi.fn(async () => sessionResponse());
    vi.stubGlobal(`fetch`, fetchMock);
    const { useSandboxSession } = await load();
    const { getSessionToken } = useSandboxSession();
    const [first, second] = await Promise.all([getSessionToken(), getSessionToken()]);
    expect(first).toEqual({ token: `sess-minted`, kind: `session` });
    expect(second).toEqual({ token: `sess-minted`, kind: `session` });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.minted).toBe(1);
});

/* A DAEMON THAT WILL NOT MINT IS BROKEN, NOT OLD, and both spellings of the refusal say so. A 404 used to
 * mean "this build predates the route" and bought the caller a raw Google ID token per call, silently: a
 * credential mode nobody chose, on a sandbox nothing reported as degraded. The exchange is the only road to a
 * bearer now, so the failure surfaces where it happened. */
it.each([
    [404, /refused its session exchange \(404\)/],
    [500, /refused its session exchange \(500\)/],
])(`fails loudly on a %i exchange rather than spending a raw Google token`, async (status, message) => {
    vi.stubGlobal(
        `fetch`,
        vi.fn(async () => new Response(`refused`, { status })),
    );
    const { useSandboxSession } = await load();
    await expect(useSandboxSession().getSessionToken()).rejects.toThrow(message);
});

it(`serves a session nearing expiry immediately and renews it in the background with the session bearer`, async () => {
    localStorage.setItem(`intentic.session.sb-1`, session({ expiresAt: Date.now() + 3 * DAY_MS }));
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => sessionResponse(`sess-renewed`));
    vi.stubGlobal(`fetch`, fetchMock);
    const { useSandboxSession } = await load();
    expect(await useSandboxSession().getSessionToken()).toEqual({ token: `sess-stored`, kind: `session` });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers).toMatchObject({ authorization: `Bearer sess-stored` });
    await vi.waitFor(() => expect(JSON.parse(localStorage.getItem(`intentic.session.sb-1`) ?? ``).token).toBe(`sess-renewed`));
    // No Google involvement at any point.
    expect(state.minted).toBe(0);
});

it(`re-establishes after an expired session, and after invalidateSession`, async () => {
    localStorage.setItem(`intentic.session.sb-1`, session({ expiresAt: Date.now() - 1000 }));
    const fetchMock = vi.fn(async () => sessionResponse());
    vi.stubGlobal(`fetch`, fetchMock);
    const { useSandboxSession } = await load();
    const { getSessionToken, invalidateSession } = useSandboxSession();
    expect(await getSessionToken()).toEqual({ token: `sess-minted`, kind: `session` });
    expect(state.minted).toBe(1);
    invalidateSession();
    expect(localStorage.getItem(`intentic.session.sb-1`)).toBeNull();
    expect(await getSessionToken()).toEqual({ token: `sess-minted`, kind: `session` });
    expect(state.minted).toBe(2);
});

it(`clearSessions forgets every sandbox's session and nothing else`, async () => {
    localStorage.setItem(`intentic.session.sb-1`, session());
    localStorage.setItem(`intentic.session.sb-2`, session());
    localStorage.setItem(`intentic.activeSandboxId`, `sb-1`);
    const { useSandboxSession } = await load();
    useSandboxSession().clearSessions();
    expect(localStorage.getItem(`intentic.session.sb-1`)).toBeNull();
    expect(localStorage.getItem(`intentic.session.sb-2`)).toBeNull();
    expect(localStorage.getItem(`intentic.activeSandboxId`)).toBe(`sb-1`);
});

it(`a late establishment cannot repopulate credentials after clearSessions`, async () => {
    let answer: ((response: Response) => void) | undefined;
    vi.stubGlobal(
        `fetch`,
        vi.fn(
            () =>
                new Promise<Response>((resolve) => {
                    answer = resolve;
                }),
        ),
    );
    const { useSandboxSession } = await load();
    const { getSessionToken, clearSessions } = useSandboxSession();
    const pending = getSessionToken();
    await vi.waitFor(() => expect(answer).toBeTypeOf(`function`));
    clearSessions();
    answer?.(sessionResponse(`late-session`));
    await expect(pending).resolves.toBeUndefined();
    expect(localStorage.getItem(`intentic.session.sb-1`)).toBeNull();
});

it(`resolves undefined when the user dismisses the sign-in gate. nothing to exchange`, async () => {
    state.idToken = undefined;
    const fetchMock = vi.fn();
    vi.stubGlobal(`fetch`, fetchMock);
    const { useSandboxSession } = await load();
    expect(await useSandboxSession().getSessionToken()).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
});

/* NOBODY IS WAITING, SO NOBODY IS ASKED. The app reads across sandboxes on a timer now (fleetAcross,
 * changesAcross: one poll per box, plus one per surface on every page load), and a box this browser holds no
 * session for takes the whole establishment path. Its first step was a Google mint — browser UI, and behind it
 * a window-wide gate — raised on behalf of a machine the reader is not looking at, with nothing on the gate
 * able to name it. Worse, a box that cannot answer stores nothing, so the same prompt came back on the next
 * tick and on the next refresh: one stopped laptop in the account was enough to make signing in feel constant. */
const otherBox = { sandboxId: `sb-2`, base: `https://other.test`, connectToken: `connect-2` };

it(`a background read with no proof in hand asks Google for nothing and exchanges nothing`, async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal(`fetch`, fetchMock);
    const { useSandboxSession } = await load();
    expect(await useSandboxSession().getSessionToken(otherBox, { background: true })).toBeUndefined();
    expect(state.minted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
});

// The other half of the same rule: a poll that CAN establish still does, silently, and the box is then good for
// a month. Refusing to reach for a credential is not refusing to use one.
it(`a background read spends a proof already in hand`, async () => {
    state.cachedIdToken = `cached-token`;
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => sessionResponse(`sess-sb2`));
    vi.stubGlobal(`fetch`, fetchMock);
    const { useSandboxSession } = await load();
    expect(await useSandboxSession().getSessionToken(otherBox, { background: true })).toEqual({ token: `sess-sb2`, kind: `session` });
    expect(fetchMock.mock.calls[0]![1].headers).toMatchObject({ authorization: `Bearer cached-token` });
    expect(state.minted).toBe(0);
});

/* A SIGN-IN IS ALWAYS ASKED FOR ON BEHALF OF A DAEMON, so that daemon has to be there. A stopped sandbox cannot
 * complete the exchange whatever the reader does, so the prompt buys them nothing at all: no session is stored,
 * and the next call asks again. The probe is the same identity-checked /health the transport qualifies
 * addresses with, and it is paid only on the path that would otherwise put Google on the screen. */
it(`will not raise a sign-in for a daemon that is not answering`, async () => {
    state.daemonAnswers = false;
    const fetchMock = vi.fn();
    vi.stubGlobal(`fetch`, fetchMock);
    const { useSandboxSession } = await load();
    expect(await useSandboxSession().getSessionToken()).toBeUndefined();
    expect(state.minted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
});

// A box that just failed is not asked again on every tick and every refresh. A press is never held back by the
// cooldown, because the reason somebody presses is usually that they have this second brought the machine back.
it(`holds a failed background establishment for a cooldown, but never a foreground one`, async () => {
    state.cachedIdToken = `cached-token`;
    const fetchMock = vi.fn(() => Promise.reject(new TypeError(`fetch failed`)));
    vi.stubGlobal(`fetch`, fetchMock);
    const { getSessionToken } = (await load()).useSandboxSession();
    await expect(getSessionToken(otherBox, { background: true })).rejects.toThrow(`fetch failed`);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The next poll tick, seconds later: the box is known not to be answering, so nothing goes out.
    expect(await getSessionToken(otherBox, { background: true })).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(getSessionToken(otherBox)).rejects.toThrow(`fetch failed`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
});

// Sharing an establishment goes one way only. A poll may settle for what a press produces; a press may not
// settle for what a poll produces, since a poll is content with "no credential, then" and a person is not.
it(`a press does not adopt an establishment a poll started`, async () => {
    state.cachedIdToken = `cached-token`;
    const answers: ((response: Response) => void)[] = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => answers.push(resolve)));
    vi.stubGlobal(`fetch`, fetchMock);
    const { getSessionToken } = (await load()).useSandboxSession();
    void getSessionToken(otherBox, { background: true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    void getSessionToken(otherBox);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // ...while a second poll joins whichever one is out, rather than opening a third.
    void getSessionToken(otherBox, { background: true });
    await new Promise((resolve) => setTimeout(resolve));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Both exchanges are answered rather than left parked: every previously loaded copy of this module still
    // watches the shared active-sandbox ref, so an establishment left in flight here answers a LATER test's
    // switch as a sign-in worth cancelling (the same reason `mintParks` is released in afterEach).
    for (const answer of answers) {
        answer(sessionResponse());
    }
    await new Promise((resolve) => setTimeout(resolve));
});

/* WHAT A 401 IS ALLOWED TO COST. The daemon session is a per-sandbox credential and the Google proof is the
 * ~1h thing that establishes it, so clearing the second is not a retry, it is a visible sign-in gate: the
 * mint that follows has no cached token to serve and `clearCredential` has switched Google's automatic
 * re-authentication off. A refused SESSION must therefore never reach it, however the refusals arrive. */
it(`a rejected session never costs the Google proof, however many calls were holding it`, async () => {
    localStorage.setItem(`intentic.session.sb-1`, session({ token: `sess-A` }));
    const { useSandboxSession } = await load();
    const { getSessionToken, rejectSessionToken } = useSandboxSession();
    const target = { sandboxId: `sb-1`, base: `https://daemon.test`, connectToken: `connect` };
    const bearer = await getSessionToken(target);

    // Two requests were in flight on the same session and the daemon refused both. The first drops it; the
    // second finds nothing on file, which used to fall through to clearing Google.
    rejectSessionToken(target, bearer!);
    rejectSessionToken(target, bearer!);
    expect(localStorage.getItem(`intentic.session.sb-1`)).toBeNull();
    expect(state.cleared).toBe(0);
});

it(`…including when the other window's invalidate lands first`, async () => {
    localStorage.setItem(`intentic.session.sb-1`, session({ token: `sess-A` }));
    const { useSandboxSession } = await load();
    const { getSessionToken, rejectSessionToken, invalidateSession } = useSandboxSession();
    const target = { sandboxId: `sb-1`, base: `https://daemon.test`, connectToken: `connect` };
    const bearer = await getSessionToken(target);

    invalidateSession(`sb-1`);
    rejectSessionToken(target, bearer!);
    expect(state.cleared).toBe(0);
});

/* …and a refusal from a box NOBODY ASKED ABOUT says nothing about the credential either. Clearing the proof
 * turns Google's automatic re-authentication off, so the next mint anywhere in the app is a visible gate: far
 * too much to spend on a poll of a machine the reader is not looking at, whose likelier explanations (a sandbox
 * bound to another account, a member since removed) are not about the token at all. */
it(`a background exchange refused with 401 keeps the Google proof`, async () => {
    state.cachedIdToken = `cached-token`;
    vi.stubGlobal(
        `fetch`,
        vi.fn(async () => new Response(`no`, { status: 401 })),
    );
    const { useSandboxSession } = await load();
    expect(await useSandboxSession().getSessionToken(otherBox, { background: true })).toBeUndefined();
    expect(state.cleared).toBe(0);
    expect(state.minted).toBe(0);
    expect(localStorage.getItem(`intentic.session.sb-2`)).toBeNull();
});

// Loopback: no sandbox id to key a session by, so the raw Google proof is the bearer. It is the only caller
// that still spends one, and a rejection has to throw it away or a dead token is replayed forever.
it(`a rejected raw Google proof still clears it, so a dead token cannot be replayed forever`, async () => {
    const { useSandboxSession } = await load();
    const { getSessionToken, rejectSessionToken } = useSandboxSession();
    const target = { sandboxId: undefined, base: `https://daemon.test`, connectToken: `connect` };
    const bearer = await getSessionToken(target);
    expect(bearer).toEqual({ token: `id-token`, kind: `google` });

    rejectSessionToken(target, bearer!);
    expect(state.cleared).toBe(1);
});

// A session already superseded (a background renewal, the other window's write) was not the one refused, and
// retiring its successor spends a round trip on a credential nothing has rejected.
it(`a rejection that names a superseded session leaves the current one alone`, async () => {
    localStorage.setItem(`intentic.session.sb-1`, session({ token: `sess-current` }));
    const { useSandboxSession } = await load();
    const { getSessionToken, rejectSessionToken } = useSandboxSession();
    const target = { sandboxId: `sb-1`, base: `https://daemon.test`, connectToken: `connect` };
    await getSessionToken(target);

    rejectSessionToken(target, { token: `sess-previous`, kind: `session` });
    expect(JSON.parse(localStorage.getItem(`intentic.session.sb-1`) ?? ``).token).toBe(`sess-current`);
    expect(state.cleared).toBe(0);
});

// One sandbox's 401 used to discard a session ANOTHER sandbox had just minted, because the generation guard
// was a single counter: the exchange landed, the write was skipped, and the next call established again.
it(`invalidating one sandbox does not discard a session another sandbox just minted`, async () => {
    let answer: ((response: Response) => void) | undefined;
    vi.stubGlobal(
        `fetch`,
        vi.fn(
            () =>
                new Promise<Response>((resolve) => {
                    answer = resolve;
                }),
        ),
    );
    const { useSandboxSession } = await load();
    const { getSessionToken, invalidateSession } = useSandboxSession();
    const pending = getSessionToken({ sandboxId: `sb-1`, base: `https://daemon.test`, connectToken: `connect` });
    await vi.waitFor(() => expect(answer).toBeTypeOf(`function`));

    invalidateSession(`sb-2`);
    answer?.(sessionResponse(`sess-sb1`));

    await expect(pending).resolves.toEqual({ token: `sess-sb1`, kind: `session` });
    expect(JSON.parse(localStorage.getItem(`intentic.session.sb-1`) ?? ``).token).toBe(`sess-sb1`);
});

/* THE GATE MUST NOT OUTLIVE ITS REASON. Establishing a session parks on a Google mint, and the mint raises a
 * window-wide overlay (immediately when Google skips the prompt, five seconds later otherwise). Switching away
 * used to leave it standing over the sandbox the user moved TO — one that needs nothing — and every window of
 * the app showed it at once, because the popped-out panels follow the active sandbox. */
it(`a switch away settles the sign-in left parked for the sandbox being left`, async () => {
    state.mintParks = true; // The establish is waiting on Google, which is what puts the gate up.
    const { useSandboxSession } = await load();
    void useSandboxSession().getSessionToken();
    await vi.waitFor(() => expect(state.minted).toBe(1));

    state.select(`sb-2`);
    await vi.waitFor(() => expect(state.canceled).toBe(1));
});

it(`a switch with nothing parked leaves the sign-in alone`, async () => {
    localStorage.setItem(`intentic.session.sb-1`, session());
    vi.stubGlobal(`fetch`, vi.fn());
    const { useSandboxSession } = await load();
    await useSandboxSession().getSessionToken();

    state.select(`sb-2`);
    await new Promise((resolve) => setTimeout(resolve));
    expect(state.canceled).toBe(0);
});

it(`presentedEmail names the session identity, falling back to the Google credential without one`, async () => {
    localStorage.setItem(`intentic.session.sb-1`, session({ email: `member@x.com` }));
    const { useSandboxSession } = await load();
    const { presentedEmail, invalidateSession } = useSandboxSession();
    expect(presentedEmail.value).toBe(`member@x.com`);
    invalidateSession();
    expect(presentedEmail.value).toBe(`google@x.com`);
});
