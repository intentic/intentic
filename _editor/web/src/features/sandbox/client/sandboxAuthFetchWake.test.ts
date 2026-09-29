import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";

// After a PC wakes, its loopback address can stay dead for minutes while the tunnel answers at once. A call no longer
// sits out the 45 s headers deadline on it: it waits for the wake's re-check and follows the verdict, and one already
// waiting is dropped the moment the address is found dead, so its caller's retry goes to the tunnel.

const LOCAL = `https://s1.loopback.test:4001`;
const TUNNEL = `https://s1.tunnel.test`;

// What the fake endpoint module hands out: the wake's re-check in flight, and who listens for a dead address.
interface FakeEndpoint {
    recheck: Promise<void> | undefined;
    readonly lost: ((base: string) => void)[];
}
const endpoint: FakeEndpoint = { recheck: undefined, lost: [] };
let current = { sandboxId: `s1`, base: LOCAL, connectToken: undefined };

jest.mock("../session/sandboxSession", () => ({
    useSandboxSession: () => ({
        getSessionToken: async () => ({ token: `bearer`, kind: `session` as const }),
        rejectSessionToken: () => undefined,
    }),
}));
jest.mock("./useSandbox", () => ({
    useSandbox: () => ({ active: { value: { token: `connect` } }, activeSandboxId: { value: `s1` }, daemonUrl: { value: TUNNEL } }),
}));
jest.mock("./sandboxTarget", () => ({ currentSandboxTarget: () => current }));
jest.mock("../secrets/useEndpoint", () => ({
    useEndpoint: () => ({
        usingLocal: { value: false },
        demoteIfUnreachable: async () => false,
        routeRechecked: (sandboxId: string) => (sandboxId === `s1` ? endpoint.recheck : undefined),
        onRouteLost: (listener: (base: string) => void) => {
            endpoint.lost.push(listener);
            return () => undefined;
        },
    }),
}));

const { sandboxAuthenticatedFetch, SandboxTimeoutError } = await import("./sandboxAuthFetch");

const fetchMock = jest.fn<(request: Request) => Promise<Response>>();
// A request that never answers until something aborts it, as a dead loopback address behaves.
const hang = (request: Request): Promise<Response> =>
    new Promise((_resolve, reject) => {
        request.signal.addEventListener(`abort`, () => reject(new DOMException(`aborted`, `AbortError`)), { once: true });
    });
const sent = (call: number): Request | undefined => fetchMock.mock.calls[call]?.[0];
const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 10; turn += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- draining microtasks one turn at a time is the point
        await Promise.resolve();
    }
};

beforeEach(() => {
    endpoint.recheck = undefined;
    current = { sandboxId: `s1`, base: LOCAL, connectToken: undefined };
    fetchMock.mockReset();
    stubGlobal(`fetch`, fetchMock);
});
afterEach(() => unstubAllGlobals());

it(`waits for the wake's re-check, then sends the same call to the tunnel when the loopback was found dead`, async () => {
    let verdict = (): void => undefined;
    endpoint.recheck = new Promise<void>((resolve) => {
        verdict = resolve;
    });
    fetchMock.mockResolvedValue(new Response(`{}`, { status: 200 }));

    const answer = sandboxAuthenticatedFetch(new Request(`${LOCAL}/agents/a/seen`, { method: `POST`, body: `{"at":1}` }), {
        sandboxId: `s1`,
        base: LOCAL,
        connectToken: undefined,
    });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(0);

    current = { sandboxId: `s1`, base: TUNNEL, connectToken: undefined };
    verdict();
    expect((await answer).status).toBe(200);

    expect(sent(0)?.url).toBe(`${TUNNEL}/agents/a/seen`);
    expect(sent(0)?.method).toBe(`POST`);
    expect(await sent(0)?.text()).toBe(`{"at":1}`);
    expect(sent(0)?.headers.get(`authorization`)).toBe(`Bearer bearer`);
});

it(`stays on the loopback address when the re-check found it alive`, async () => {
    endpoint.recheck = Promise.resolve();
    fetchMock.mockResolvedValue(new Response(`{}`, { status: 200 }));

    await sandboxAuthenticatedFetch(new Request(`${LOCAL}/workspace/tree`), { sandboxId: `s1`, base: LOCAL, connectToken: undefined });

    expect(sent(0)?.url).toBe(`${LOCAL}/workspace/tree`);
});

it(`drops the calls waiting on an address found dead as timed out, and leaves the tunnel's alone`, async () => {
    fetchMock.mockImplementation(hang);
    const onLoopback = sandboxAuthenticatedFetch(new Request(`${LOCAL}/workspace/tree`), { sandboxId: `s1`, base: LOCAL, connectToken: undefined });
    const onTunnel = sandboxAuthenticatedFetch(new Request(`${TUNNEL}/workspace/tree`), { sandboxId: `s1`, base: TUNNEL, connectToken: undefined });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    for (const listener of endpoint.lost) {
        listener(LOCAL);
    }

    await expect(onLoopback).rejects.toBeInstanceOf(SandboxTimeoutError);
    let tunnelSettled = false;
    void onTunnel.then(
        () => {
            tunnelSettled = true;
        },
        () => {
            tunnelSettled = true;
        },
    );
    await settle();
    expect(tunnelSettled).toBe(false);
});

it(`keeps the caller's own abort as it was`, async () => {
    fetchMock.mockImplementation(hang);
    const caller = new AbortController();
    const answer = sandboxAuthenticatedFetch(new Request(`${LOCAL}/workspace/tree`, { signal: caller.signal }), {
        sandboxId: `s1`,
        base: LOCAL,
        connectToken: undefined,
    });
    await settle();
    caller.abort();

    await expect(answer).rejects.toMatchObject({ name: `AbortError` });
});
