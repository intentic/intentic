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
 * pre-session daemons degrade to the raw ID token (and are not re-probed per call); renewal happens in the
 * background with the session itself. */

const state = vi.hoisted(() => ({
    idToken: `id-token` as string | undefined,
    minted: 0,
    advertised: undefined as boolean | undefined,
    sandboxId: `sb-1` as string | undefined,
}));

vi.mock("../useGoogleIdentity", () => ({
    useGoogleIdentity: () => ({
        getIdToken: async () => {
            state.minted += 1;
            return state.idToken;
        },
        signedInEmail: { value: `google@x.com` },
        clearCredential: vi.fn(),
    }),
}));
vi.mock("./useSandbox", () => ({
    useSandbox: () => ({
        active: {
            get value() {
                return state.sandboxId === undefined ? undefined : { id: state.sandboxId, token: `connect` };
            },
        },
        activeSandboxId: {
            get value() {
                return state.sandboxId;
            },
        },
        daemonUrl: { value: `https://daemon.test` },
    }),
}));
vi.mock("./useDaemonRoutes", () => ({ routeAdvertised: () => state.advertised }));

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

// Fresh module per test: the singleton carries the in-memory session mirror and the learned-unsupported set.
const load = async (): Promise<typeof import("./sandboxSession")> => {
    vi.resetModules();
    return import("./sandboxSession");
};

beforeEach(() => {
    stubStorage();
    state.idToken = `id-token`;
    state.minted = 0;
    state.advertised = undefined;
    state.sandboxId = `sb-1`;
});
afterEach(() => vi.unstubAllGlobals());

it(`serves a valid stored session with no Google mint and no network`, async () => {
    localStorage.setItem(`intentic.session.sb-1`, session());
    const fetchMock = vi.fn();
    vi.stubGlobal(`fetch`, fetchMock);
    const { useSandboxSession } = await load();
    expect(await useSandboxSession().getSessionToken()).toBe(`sess-stored`);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.minted).toBe(0);
});

it(`establishes a session from a Google proof: one exchange, persisted, then served from cache`, async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => sessionResponse());
    vi.stubGlobal(`fetch`, fetchMock);
    const { useSandboxSession } = await load();
    expect(await useSandboxSession().getSessionToken()).toBe(`sess-minted`);
    // The exchange call: the daemon's session route, the Google bearer, the TOFU connect token.
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://daemon.test/system/session`);
    expect(init.headers).toMatchObject({ authorization: `Bearer id-token`, "x-intentic-connect": `connect` });
    expect(JSON.parse(localStorage.getItem(`intentic.session.sb-1`) ?? ``)).toMatchObject({ token: `sess-minted`, email: `o@x.com` });
    // Steady state: the second call touches nothing.
    expect(await useSandboxSession().getSessionToken()).toBe(`sess-minted`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.minted).toBe(1);
});

it(`shares one in-flight establish across concurrent calls`, async () => {
    const fetchMock = vi.fn(async () => sessionResponse());
    vi.stubGlobal(`fetch`, fetchMock);
    const { useSandboxSession } = await load();
    const { getSessionToken } = useSandboxSession();
    const [first, second] = await Promise.all([getSessionToken(), getSessionToken()]);
    expect(first).toBe(`sess-minted`);
    expect(second).toBe(`sess-minted`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.minted).toBe(1);
});

it(`falls back to the raw ID token on a 404 exchange and stops probing, until the route is advertised`, async () => {
    const fetchMock = vi.fn(async () => new Response(`not found`, { status: 404 }));
    vi.stubGlobal(`fetch`, fetchMock);
    const { useSandboxSession } = await load();
    const { getSessionToken } = useSandboxSession();
    expect(await getSessionToken()).toBe(`id-token`);
    expect(await getSessionToken()).toBe(`id-token`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The daemon was updated mid-session: a hello now advertises the route, so the exchange is retried.
    state.advertised = true;
    fetchMock.mockImplementation(async () => sessionResponse());
    expect(await getSessionToken()).toBe(`sess-minted`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
});

it(`does not fall back to the raw Google token when session exchange fails`, async () => {
    vi.stubGlobal(
        `fetch`,
        vi.fn(async () => new Response(`broken`, { status: 500 })),
    );
    const { useSandboxSession } = await load();
    await expect(useSandboxSession().getSessionToken()).rejects.toThrow(/refused its session exchange/);
});

it(`skips the exchange entirely when the daemon positively advertises no session route`, async () => {
    state.advertised = false;
    const fetchMock = vi.fn();
    vi.stubGlobal(`fetch`, fetchMock);
    const { useSandboxSession } = await load();
    expect(await useSandboxSession().getSessionToken()).toBe(`id-token`);
    expect(fetchMock).not.toHaveBeenCalled();
});

it(`serves a session nearing expiry immediately and renews it in the background with the session bearer`, async () => {
    localStorage.setItem(`intentic.session.sb-1`, session({ expiresAt: Date.now() + 3 * DAY_MS }));
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => sessionResponse(`sess-renewed`));
    vi.stubGlobal(`fetch`, fetchMock);
    const { useSandboxSession } = await load();
    expect(await useSandboxSession().getSessionToken()).toBe(`sess-stored`);
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
    expect(await getSessionToken()).toBe(`sess-minted`);
    expect(state.minted).toBe(1);
    invalidateSession();
    expect(localStorage.getItem(`intentic.session.sb-1`)).toBeNull();
    expect(await getSessionToken()).toBe(`sess-minted`);
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

it(`presentedEmail names the session identity, falling back to the Google credential without one`, async () => {
    localStorage.setItem(`intentic.session.sb-1`, session({ email: `member@x.com` }));
    const { useSandboxSession } = await load();
    const { presentedEmail, invalidateSession } = useSandboxSession();
    expect(presentedEmail.value).toBe(`member@x.com`);
    invalidateSession();
    expect(presentedEmail.value).toBe(`google@x.com`);
});
