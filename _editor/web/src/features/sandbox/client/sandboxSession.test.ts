import { afterEach, beforeEach, expect, it, vi } from "vitest";
// Imported once for its load cost, so the first test doesn't pay it inside its own timeout; each test still
// gets a fresh module via load() below (vi.resetModules).
// oxlint-disable-next-line import/no-unassigned-import -- imported for its load cost alone, not for a binding
import "./sandboxSession";

// useSandboxSession picks the bearer for a call: a valid stored session needs no Google or network, a refusal
// fails loudly instead of degrading to a raw ID token, and renewal near expiry uses the session itself.

const state = vi.hoisted(() => ({
    idToken: `id-token` as string | undefined,
    // The only proof a background reader may spend; undefined by default, since a reload finds no live Google cache.
    cachedIdToken: undefined as string | undefined,
    minted: 0,
    // Whether the target daemon answers its /health; a sign-in must never be raised for a machine that's off.
    daemonAnswers: true,
    // What the Google layer was asked to do with the credential; a session rejection must never reach either.
    cleared: 0,
    canceled: 0,
    sandboxId: `sb-1` as string | undefined,
    // A mint that never resolves, the state left behind while Google's prompt is up. Released in afterEach since
    // the mocked useSandbox ref is shared across every loaded copy of the module in this file.
    mintParks: false,
    releaseMint: (): void => {},
    // Points the workspace at another sandbox like the switcher does, via the ref the module watches.
    select: (_id: string | undefined): void => {},
}));

vi.mock("../../auth/useGoogleIdentity", () => ({
    useGoogleIdentity: () => ({
        getIdToken: async (options?: { interactive?: boolean }) => {
            // interactive:false is a caller with no standing to interrupt: silence or nothing, never a prompt to count.
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
// Stubs the reachability check at the seam rather than a real /health response; endpoint.ts tests that check
// itself, and target resolution underneath is otherwise real.
vi.mock("../secrets/endpoint", async () => ({
    ...(await vi.importActual<typeof import("../secrets/endpoint")>(`../secrets/endpoint`)),
    healthAnswers: async () => state.daemonAnswers,
    sandboxIdOf: async () => `sb-1`,
}));
// A real ref, not a getter, since the module watches the active sandbox to settle a parked mint on a switch.
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
// A minimal Storage stand-in for the node test environment, backed by a Map.
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

// Fresh module per test, since the singleton carries the in-memory session mirror.
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
    // The active-sandbox ref lives in the mock factory (evaluated once per file) and survives load(); reset by hand.
    state.select(`sb-1`);
});
afterEach(async () => {
    state.releaseMint();
    state.releaseMint = () => {};
    // One tick for a released establish to fall out of its module's inflight map.
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
    // Checks the exchange request: the daemon's session route, the Google bearer, the TOFU connect token.
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

// The exchange is the only road to a bearer; failure surfaces immediately rather than falling back to a raw
// Google token unreported.
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

// Background reads happen on a timer across every sandbox in the account; nobody is waiting, so nothing may
// prompt for a credential, and a box that can't answer must not be re-asked constantly.
const otherBox = { sandboxId: `sb-2`, base: `https://other.test`, connectToken: `connect-2` };

it(`a background read with no proof in hand asks Google for nothing and exchanges nothing`, async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal(`fetch`, fetchMock);
    const { useSandboxSession } = await load();
    expect(await useSandboxSession().getSessionToken(otherBox, { background: true })).toBeUndefined();
    expect(state.minted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
});

// The other half of the rule: a poll that can establish still does, silently, without prompting for one.
it(`a background read spends a proof already in hand`, async () => {
    state.cachedIdToken = `cached-token`;
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => sessionResponse(`sess-sb2`));
    vi.stubGlobal(`fetch`, fetchMock);
    const { useSandboxSession } = await load();
    expect(await useSandboxSession().getSessionToken(otherBox, { background: true })).toEqual({ token: `sess-sb2`, kind: `session` });
    expect(fetchMock.mock.calls[0]![1].headers).toMatchObject({ authorization: `Bearer cached-token` });
    expect(state.minted).toBe(0);
});

// The probe is the same identity-checked /health the transport already uses, paid only on this path.
it(`will not raise a sign-in for a daemon that is not answering`, async () => {
    state.daemonAnswers = false;
    const fetchMock = vi.fn();
    vi.stubGlobal(`fetch`, fetchMock);
    const { useSandboxSession } = await load();
    expect(await useSandboxSession().getSessionToken()).toBeUndefined();
    expect(state.minted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
});

it(`holds a failed background establishment for a cooldown, but never a foreground one`, async () => {
    state.cachedIdToken = `cached-token`;
    const fetchMock = vi.fn(() => Promise.reject(new TypeError(`fetch failed`)));
    vi.stubGlobal(`fetch`, fetchMock);
    const { getSessionToken } = (await load()).useSandboxSession();
    await expect(getSessionToken(otherBox, { background: true })).rejects.toThrow(`fetch failed`);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Simulates the next poll tick: the box is already known not to be answering, so nothing goes out.
    expect(await getSessionToken(otherBox, { background: true })).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(getSessionToken(otherBox)).rejects.toThrow(`fetch failed`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
});

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

    // Both exchanges are drained rather than left parked: an in-flight establishment here would answer a later
    // test's switch too, since every loaded module copy shares the active-sandbox ref.
    for (const answer of answers) {
        answer(sessionResponse());
    }
    await new Promise((resolve) => setTimeout(resolve));
});

// Clearing the Google proof would turn off silent reauth, forcing a visible gate on the next mint; a session
// rejection must never do that.
it(`a rejected session never costs the Google proof, however many calls were holding it`, async () => {
    localStorage.setItem(`intentic.session.sb-1`, session({ token: `sess-A` }));
    const { useSandboxSession } = await load();
    const { getSessionToken, rejectSessionToken } = useSandboxSession();
    const target = { sandboxId: `sb-1`, base: `https://daemon.test`, connectToken: `connect` };
    const bearer = await getSessionToken(target);

    // Two concurrent rejections on the same session: the first drops it, the second finds nothing on file and must
    // not fall through to clearing Google.
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

// A background refusal says nothing about the credential either; clearing it would force a visible gate everywhere.
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

// Loopback has no sandbox id to key a session by, so the raw Google proof is the bearer, and is the one still
// cleared on rejection.
it(`a rejected raw Google proof still clears it, so a dead token cannot be replayed forever`, async () => {
    const { useSandboxSession } = await load();
    const { getSessionToken, rejectSessionToken } = useSandboxSession();
    const target = { sandboxId: undefined, base: `https://daemon.test`, connectToken: `connect` };
    const bearer = await getSessionToken(target);
    expect(bearer).toEqual({ token: `id-token`, kind: `google` });

    rejectSessionToken(target, bearer!);
    expect(state.cleared).toBe(1);
});

// A session already replaced (a renewal, another window's write) was not the one refused.
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
