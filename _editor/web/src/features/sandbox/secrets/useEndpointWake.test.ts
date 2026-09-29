import { localDaemonPort } from "@intentic/sandbox-run";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { ref } from "vue";
import { sandboxIdOf } from "./endpoint";

// The re-check a page runs on its loopback address after it slept: a live address (the usual wake) is asked alone and
// kept; a dead one is left for the tunnel the moment the tunnel answers, and the calls waiting on it are told.

const TOKEN = `connect-token`;
const HOSTNAME = `s1.loopback.test`;
const TUNNEL = `https://s1.tunnel.test`;
const ID = await sandboxIdOf(TOKEN);
const LOCAL = `https://${HOSTNAME}:${localDaemonPort(ID)}`;

jest.mock("../devices/loopback/localShortcut", () => ({
    shortcutAnswer: async () => `allowed` as const,
    useLocalShortcut: () => ({ ask: () => undefined }),
}));
jest.mock("../client/useSandbox", () => ({
    useSandbox: () => ({
        active: ref({ token: TOKEN, hosted: null, localHostname: HOSTNAME }),
        activeSandboxId: ref(`s1`),
        daemonUrl: ref(TUNNEL),
    }),
}));

const { useEndpoint } = await import("./useEndpoint");
const { daemonBase, resolve, recheckAfterWake, routeRechecked, onRouteLost, reset } = useEndpoint();

// Which bases answer /health as this sandbox; the rest refuse the connection, as a dead port does.
const alive = new Set<string>();
const fetchMock = jest.fn<(input: RequestInfo | URL) => Promise<Response>>(async (input) => {
    const url = String(input);
    const base = [...alive].find((candidate) => url.startsWith(candidate));
    if (base === undefined) {
        throw new TypeError(`Failed to fetch`);
    }
    return new Response(JSON.stringify({ sandboxId: ID }), { status: 200 });
});
const asked = (): string[] => fetchMock.mock.calls.map(([input]) => String(input));

const lost: string[] = [];
onRouteLost((base) => lost.push(base));

beforeEach(async () => {
    stubGlobal(`fetch`, fetchMock);
    reset(`s1`);
    alive.clear();
    alive.add(LOCAL);
    alive.add(TUNNEL);
    lost.length = 0;
    await resolve();
    fetchMock.mockClear();
});
afterEach(() => unstubAllGlobals());

it(`keeps a loopback address that answers after the sleep, asking it alone`, async () => {
    expect(daemonBase.value).toBe(LOCAL);

    recheckAfterWake();
    await routeRechecked(`s1`);

    expect(daemonBase.value).toBe(LOCAL);
    expect(asked()).toEqual([`${LOCAL}/health`]);
    expect(lost).toEqual([]);
});

it(`leaves a dead loopback address for the tunnel, and tells the calls waiting on it`, async () => {
    expect(daemonBase.value).toBe(LOCAL);
    alive.delete(LOCAL);

    recheckAfterWake();
    await routeRechecked(`s1`);

    expect(daemonBase.value).toBe(TUNNEL);
    expect(lost).toEqual([LOCAL]);
    expect(routeRechecked(`s1`)).toBeUndefined();
});

it(`keeps a dead loopback address when the tunnel is silent too: nothing better to go to`, async () => {
    alive.clear();

    recheckAfterWake();
    await routeRechecked(`s1`);

    expect(daemonBase.value).toBe(LOCAL);
    expect(lost).toEqual([]);
});

it(`runs one re-check at a time`, async () => {
    recheckAfterWake();
    const first = routeRechecked(`s1`);
    recheckAfterWake();

    expect(routeRechecked(`s1`)).toBe(first);
    await first;
});
