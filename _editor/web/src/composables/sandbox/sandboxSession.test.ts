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
    minted: 0,
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
        getIdToken: async () => {
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
