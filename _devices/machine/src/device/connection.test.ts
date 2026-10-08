import { HOST_HEARTBEAT_MS } from "@intentic/sandbox-contract";
import { PEER_LINK_BACKOFF, peerLinkSilenceMs } from "@intentic/sandbox-contract/peer-dial";
import { localDaemonPort } from "@intentic/sandbox-run";
import { unstubbed } from "@intentic/testing";
import { waitFor, advanceTimersByTimeAsync } from "@intentic/testing/bun";
import type { DaemonBase } from "../daemon-base.js";
import type { HostLink } from "./config.js";
import { connect, type Dial, GONE_PROBE_AFTER_ATTEMPTS, goneLinkStep, type LinkGoneStore, probeEdge, probesFirst } from "./connection.js";
import { GONE_RETIRE_MS } from "../sync/gone.js";
import type { Indicator } from "./indicator.js";

// Pins that the socket asks the resolver on every reconnect and dials the answer unchanged; the resolver
// itself is proved against real daemons in ../daemon-base.integration.test.ts.

// A sandbox on the intentic-provided path; its public URL carries the daemon's 12-hex id.
const ID = `0738cd6b5027`;
const PUBLIC = `https://sandbox-${ID}.example.dev`;
const LOCAL = `http://127.0.0.1:${localDaemonPort(ID)}`;
const LOCAL_SOCKET = `ws://127.0.0.1:${localDaemonPort(ID)}/system/hosts/connect`;
const PUBLIC_SOCKET = `wss://sandbox-${ID}.example.dev/system/hosts/connect`;

const link: HostLink = {
    sandboxUrl: PUBLIC,
    id: `my-pc`,
    token: `iht_test`,
    scopes: { shell: `off`, write: `off`, screen: `off`, control: `off`, sandboxes: `off`, destructive: `off`, programs: `off` },
};

// Enough of the WebSocket surface for the connection and the oRPC handler it upgrades into; `opens`/`drops`
// play what the far end would do.
class FakeSocket {
    readyState = 0;
    readonly sent: string[] = [];
    closed: { readonly code: number | undefined; readonly reason: string | undefined } | undefined;
    private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

    constructor(readonly url: string) {}

    addEventListener(type: string, fn: (event: never) => void): void {
        const set = this.listeners.get(type) ?? new Set();
        set.add(fn as (event: unknown) => void);
        this.listeners.set(type, set);
    }
    removeEventListener(type: string, fn: (event: never) => void): void {
        this.listeners.get(type)?.delete(fn as (event: unknown) => void);
    }
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        this.sent.push(String(data));
    }
    close(code?: number, reason?: string): void {
        this.closed = { code, reason };
        this.readyState = 3;
    }
    opens(): void {
        this.readyState = 1;
        this.emit(`open`, {});
    }
    drops(code: number): void {
        this.readyState = 3;
        this.emit(`close`, { code });
    }
    private emit(type: string, event: unknown): void {
        for (const fn of this.listeners.get(type) ?? []) {
            fn(event);
        }
    }
}

// A dial whose resolver answers from a script, one verdict per attempt; every socket it creates is kept so
// the test can read and drive it.
const dialing = (answers: DaemonBase[]): { readonly dial: Dial; readonly sockets: FakeSocket[]; readonly asked: string[] } => {
    const sockets: FakeSocket[] = [];
    const asked: string[] = [];
    const dial: Dial = {
        resolveBase: async (sandboxUrl) => {
            asked.push(sandboxUrl);
            return answers.shift() ?? { base: PUBLIC, local: false };
        },
        socket: (url) => {
            const socket = new FakeSocket(url);
            sockets.push(socket);
            return socket as unknown as WebSocket;
        },
    };
    return { dial, sockets, asked };
};

const quiet = (): void => {};

afterEach(() => jest.useRealTimers());

test(`dials the container on loopback when it proves to be this sandbox, and says so`, async () => {
    const { dial, sockets, asked } = dialing([{ base: LOCAL, local: true }]);
    const said: string[] = [];
    const connection = connect(link, `1.0.0`, (line) => void said.push(line), dial);

    await waitFor(() => expect(sockets).toHaveLength(1));
    // Asked at the link's address; dialled at the resolved one.
    expect(asked).toEqual([PUBLIC]);
    expect(sockets[0]?.url).toBe(LOCAL_SOCKET);

    sockets[0]?.opens();
    // The hello frame carries the enrollment token regardless of which address the socket is on.
    expect(JSON.parse(sockets[0]?.sent[0] ?? `{}`)).toEqual({ type: `hello`, token: `iht_test`, version: `1.0.0` });
    // The loopback fact is logged; the link's address alone would not show it.
    expect(said.join(`\n`)).toContain(`over loopback (${LOCAL})`);

    connection.stop();
    await connection.done;
});

test(`the public address is the floor, dialled as it is and without a loopback claim`, async () => {
    const { dial, sockets } = dialing([{ base: PUBLIC, local: false }]);
    const said: string[] = [];
    const connection = connect(link, `1.0.0`, (line) => void said.push(line), dial);

    await waitFor(() => expect(sockets).toHaveLength(1));
    expect(sockets[0]?.url).toBe(PUBLIC_SOCKET);
    sockets[0]?.opens();
    // The sandbox is named by the prefix every line of this link's carries, not by the open's own words.
    expect(said.join(`\n`)).toContain(`${PUBLIC}: connected as "my-pc"`);
    expect(said.join(`\n`)).not.toContain(`loopback`);

    connection.stop();
    await connection.done;
});

// One agent holds a link per sandbox and the dial agent's own complaints carry no address: unprefixed, a machine
// with five links wrote "disconnected (1002); 7172 failed attempts" for two days without naming one of them, and
// nothing in the log could tell the dead links from the live one.
test(`a drop names the sandbox that went away, not just the close code`, async () => {
    jest.useFakeTimers();
    const { dial, sockets } = dialing([{ base: PUBLIC, local: false }]);
    const said: string[] = [];
    const connection = connect(link, `1.0.0`, (line) => void said.push(line), dial);

    await waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.opens();
    sockets[0]?.drops(1002);

    expect(said.join(`\n`)).toContain(`${PUBLIC}: disconnected (1002)`);

    connection.stop();
    await connection.done;
});

// Reconnect must ask again: the container behind the socket can be gone (recreated, stopped, moved), so
// redialing the same port would fail for the rest of the login.
test(`asks again on every reconnect, so a container that went away falls back to the public address`, async () => {
    jest.useFakeTimers();
    const { dial, sockets, asked } = dialing([
        { base: LOCAL, local: true },
        { base: PUBLIC, local: false },
    ]);
    const connection = connect(link, `1.0.0`, quiet, dial);

    await waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.opens();
    sockets[0]?.drops(1006);

    // Past the backoff ceiling: the retry has fired by now.
    await advanceTimersByTimeAsync(31_000);
    await waitFor(() => expect(sockets).toHaveLength(2));

    expect(asked).toEqual([PUBLIC, PUBLIC]);
    expect(sockets[0]?.url).toBe(LOCAL_SOCKET);
    expect(sockets[1]?.url).toBe(PUBLIC_SOCKET);

    connection.stop();
    await connection.done;
});

// A stop mid-resolution must open no socket afterward: one dialled by a agent already reported done would be
// a connection nobody stops.
test(`a stop during resolution opens no socket`, async () => {
    let answer: ((base: DaemonBase) => void) | undefined;
    const sockets: FakeSocket[] = [];
    const dial: Dial = {
        resolveBase: () =>
            new Promise((resolve) => {
                answer = resolve;
            }),
        socket: (url) => {
            const socket = new FakeSocket(url);
            sockets.push(socket);
            return socket as unknown as WebSocket;
        },
    };
    const connection = connect(link, `1.0.0`, quiet, dial);
    await waitFor(() => expect(answer).toEqual(expect.any(Function)));

    connection.stop();
    await connection.done;
    answer?.({ base: LOCAL, local: true });
    // Let the resolution's continuation run before asserting on what it did not do.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(sockets).toHaveLength(0);
});

// A refused enrollment is a decision: the agent must end rather than resolve an address for a door that is
// locked.
test(`a refused enrollment ends the agent instead of redialling`, async () => {
    jest.useFakeTimers();
    const { dial, sockets, asked } = dialing([{ base: LOCAL, local: true }]);
    const said: string[] = [];
    const forgotten: string[] = [];
    const connection = connect(
        link,
        `1.0.0`,
        (line) => void said.push(line),
        dial,
        async (url) => void forgotten.push(url),
    );

    await waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.opens();
    sockets[0]?.drops(1008);
    await connection.done;

    await advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    expect(asked).toHaveLength(1);
    expect(said.join(`\n`)).toContain(`revoked`);
    // The sync half drops a revoked pairing; the device half drops a revoked link the same way, or it is redialled at every start.
    expect(forgotten).toEqual([PUBLIC]);
});

// The notice on this machine's screen says a link is driving it; once that link's socket is gone the claim is false,
// and waiting out its countdown would leave it standing. A socket abandoned for silence can report its close late,
// after the link has redialled and may be driving again, so only the latest one speaks for the link.
test(`a link's notice goes when its socket closes, and not when a socket it already left behind does`, async () => {
    jest.useFakeTimers();
    const { dial, sockets } = dialing([]);
    const released: string[] = [];
    const indicator = unstubbed<Indicator>("indicator", { release: (url) => void released.push(url) });
    const connection = connect(link, `1.0.0`, quiet, dial, async () => undefined, indicator);

    await waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.opens();
    // Silent past the watchdog: the first socket is abandoned, and the redial is at most one backoff ceiling behind.
    await advanceTimersByTimeAsync(peerLinkSilenceMs(HOST_HEARTBEAT_MS) + PEER_LINK_BACKOFF.capMs);
    await waitFor(() => expect(sockets).toHaveLength(2));
    sockets[1]?.opens();
    sockets[0]?.drops(1006);
    expect(released).toEqual([]);

    sockets[1]?.drops(1006);
    expect(released).toEqual([PUBLIC]);

    connection.stop();
    await connection.done;
});

// (2026-10-05) A LINK TO A SANDBOX THAT NO LONGER EXISTS STOPS DIALLING IT. A WebSocket cannot read the edge's 502, so
// after enough failed dials a plain GET asks the edge, whose final word marks the link gone; it is asked again hourly,
// brought back by an answer, and forgotten past the trash window.
describe(`a link whose sandbox is gone`, () => {
    const marks = (): { readonly store: LinkGoneStore; readonly marked: (number | undefined)[] } => {
        const marked: (number | undefined)[] = [];
        return { store: { mark: async (_link, since) => void marked.push(since) }, marked };
    };

    test(`asks the edge only after a run of failed dials, and reads only its final verdict as gone`, async () => {
        expect([1, GONE_PROBE_AFTER_ATTEMPTS, GONE_PROBE_AFTER_ATTEMPTS + 1].map(probesFirst)).toEqual([false, false, true]);
        const answering = (status: number, said?: string) => async () =>
            new Response(``, { status, headers: said === undefined ? {} : { "x-intentic-edge": said } });
        expect(await probeEdge(PUBLIC, answering(502, `unknown-sandbox`) as unknown as typeof fetch)).toBe(true);
        expect(await probeEdge(PUBLIC, answering(502, `no-tunnel`) as unknown as typeof fetch)).toBe(false);
        expect(await probeEdge(PUBLIC, answering(502) as unknown as typeof fetch)).toBe(false);
        expect(
            await probeEdge(PUBLIC, (async () => {
                throw new Error(`offline`);
            }) as unknown as typeof fetch),
        ).toBe(false);
    });

    test(`dials again on an answer, waits while it is gone, and is forgotten past the trash window`, () => {
        expect(goneLinkStep(0, 60_000, false)).toBe(`dial`);
        expect(goneLinkStep(0, GONE_RETIRE_MS - 1, true)).toBe(`wait`);
        expect(goneLinkStep(0, GONE_RETIRE_MS, true)).toBe(`forget`);
    });

    test(`stops dialling once the edge says so after the run of failures, and records since when`, async () => {
        jest.useFakeTimers();
        const { dial, sockets } = dialing([]);
        const said: string[] = [];
        const { store, marked } = marks();
        const connection = connect(
            link,
            `1.0.0`,
            (line) => void said.push(line),
            { ...dial, gone: async () => true },
            async () => undefined,
            undefined,
            store,
            () => 1_000,
        );

        for (let attempt = 1; attempt <= GONE_PROBE_AFTER_ATTEMPTS; attempt += 1) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- one dial after another, as the loop makes them
            await waitFor(() => expect(sockets).toHaveLength(attempt));
            sockets[attempt - 1]?.drops(1002);
            // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
            await advanceTimersByTimeAsync(31_000);
        }
        await waitFor(() => expect(marked).toEqual([1_000]));
        expect(sockets).toHaveLength(GONE_PROBE_AFTER_ATTEMPTS);
        expect(said.join(`\n`)).toContain(`the platform says this sandbox no longer exists, so this link stops dialling it`);

        connection.stop();
        await connection.done;
    });

    test(`a link marked gone before this start is asked first, and dials again at once when the sandbox answers`, async () => {
        const { dial, sockets } = dialing([{ base: PUBLIC, local: false }]);
        const { store, marked } = marks();
        const connection = connect(
            { ...link, goneSince: 1_000 } as typeof link,
            `1.0.0`,
            quiet,
            { ...dial, gone: async () => false },
            async () => undefined,
            undefined,
            store,
            () => 2_000,
        );

        await waitFor(() => expect(sockets).toHaveLength(1));
        expect(marked).toEqual([undefined]);

        connection.stop();
        await connection.done;
    });

    test(`a link gone past the trash window is forgotten without another dial`, async () => {
        const { dial, sockets } = dialing([]);
        const forgotten: string[] = [];
        const connection = connect(
            { ...link, goneSince: 1_000 } as typeof link,
            `1.0.0`,
            quiet,
            { ...dial, gone: async () => true },
            async (url) => void forgotten.push(url),
            undefined,
            marks().store,
            () => 1_000 + GONE_RETIRE_MS,
        );

        await connection.done;
        expect(forgotten).toEqual([PUBLIC]);
        expect(sockets).toHaveLength(0);
    });
});
