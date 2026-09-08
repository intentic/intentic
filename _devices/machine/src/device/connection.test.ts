import { localDaemonPort } from "@intentic/sandbox-run";
import { afterEach, expect, test, vi } from "vitest";
import type { DaemonBase } from "../daemon-base.js";
import type { HostLink } from "./config.js";
import { connect, type Dial } from "./connection.js";

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
    scopes: { shell: `off`, write: `off`, screen: `off`, control: `off`, sandboxes: `off`, sandboxRemove: `off`, destructive: `off` },
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

afterEach(() => vi.useRealTimers());

test(`dials the container on loopback when it proves to be this sandbox, and says so`, async () => {
    const { dial, sockets, asked } = dialing([{ base: LOCAL, local: true }]);
    const said: string[] = [];
    const connection = connect(link, `1.0.0`, (line) => void said.push(line), dial);

    await vi.waitFor(() => expect(sockets).toHaveLength(1));
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

    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(sockets[0]?.url).toBe(PUBLIC_SOCKET);
    sockets[0]?.opens();
    expect(said.join(`\n`)).toContain(`connected to ${PUBLIC} as "my-pc"`);
    expect(said.join(`\n`)).not.toContain(`loopback`);

    connection.stop();
    await connection.done;
});

// Reconnect must ask again: the container behind the socket can be gone (recreated, stopped, moved), so
// redialing the same port would fail for the rest of the login.
test(`asks again on every reconnect, so a container that went away falls back to the public address`, async () => {
    vi.useFakeTimers();
    const { dial, sockets, asked } = dialing([
        { base: LOCAL, local: true },
        { base: PUBLIC, local: false },
    ]);
    const connection = connect(link, `1.0.0`, quiet, dial);

    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.opens();
    sockets[0]?.drops(1006);

    // Past the backoff ceiling: the retry has fired by now.
    await vi.advanceTimersByTimeAsync(31_000);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    expect(asked).toEqual([PUBLIC, PUBLIC]);
    expect(sockets[0]?.url).toBe(LOCAL_SOCKET);
    expect(sockets[1]?.url).toBe(PUBLIC_SOCKET);

    connection.stop();
    await connection.done;
});

// A stop mid-resolution must open no socket afterward: one dialled by a loop already reported done would be
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
    await vi.waitFor(() => expect(answer).toEqual(expect.any(Function)));

    connection.stop();
    await connection.done;
    answer?.({ base: LOCAL, local: true });
    // Let the resolution's continuation run before asserting on what it did not do.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(sockets).toHaveLength(0);
});

// A refused enrollment is a decision: the loop must end rather than resolve an address for a door that is
// locked.
test(`a refused enrollment ends the loop instead of redialling`, async () => {
    vi.useFakeTimers();
    const { dial, sockets, asked } = dialing([{ base: LOCAL, local: true }]);
    const said: string[] = [];
    const connection = connect(link, `1.0.0`, (line) => void said.push(line), dial);

    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0]?.opens();
    sockets[0]?.drops(1008);
    await connection.done;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    expect(asked).toHaveLength(1);
    expect(said.join(`\n`)).toContain(`revoked`);
});
