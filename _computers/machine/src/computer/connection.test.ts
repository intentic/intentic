import { localDaemonPort } from "@intentic/sandbox-run";
import { afterEach, expect, test, vi } from "vitest";
import type { DaemonBase } from "../daemon-base.js";
import type { HostLink } from "./config.js";
import { connect, type Dial } from "./connection.js";

/* WHICH ADDRESS THE COMPUTER HALF DIALS, pinned without a network. The resolver itself is proved against real
 * loopback daemons in ../daemon-base.integration.test.ts; what is at stake here is that the socket ASKS it,
 * asks it again on every reconnect, and hands the answer to the connect URL unchanged. The link's own address
 * used to be the only one ever dialled, and the failure that bought this file is a sandbox running on the very
 * machine typing `intentic-machine status`, reading "offline" on its own Computers tab because its tunnel was. */

// A sandbox on the intentic-provided path, whose public URL carries the daemon's 12-hex id.
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

// Enough of the WebSocket surface for the connection and for the oRPC handler it upgrades the socket into.
// The test plays the network: `opens` and `drops` are what the far end would have done.
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

// A dial whose resolver answers from a script, one verdict per attempt, and whose sockets are all kept so the
// test can read what was dialled and drive each one.
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
    // Resolved from the LINK's address, which is the sandbox's identity, and dialled at the RESOLVED one.
    expect(asked).toEqual([PUBLIC]);
    expect(sockets[0]?.url).toBe(LOCAL_SOCKET);

    sockets[0]?.opens();
    // The hello is the first frame and carries the enrollment token, whichever address the socket is on: the
    // resolver's identity probe is what makes handing it to a loopback port safe.
    expect(JSON.parse(sockets[0]?.sent[0] ?? `{}`)).toEqual({ type: `hello`, token: `iht_test`, version: `1.0.0` });
    // Said in the log, because it is the one fact about this connection the link's address does not carry.
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

/* THE CASE THE PER-ATTEMPT RESOLUTION EXISTS FOR: the container this socket was on goes away (an update
 * recreated it, the user stopped it, the sandbox moved), so the reconnect must ask again rather than redial a
 * dead port for the rest of the login. */
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

    // Past the backoff ceiling, so the retry has fired whatever rung it landed on.
    await vi.advanceTimersByTimeAsync(31_000);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    expect(asked).toEqual([PUBLIC, PUBLIC]);
    expect(sockets[0]?.url).toBe(LOCAL_SOCKET);
    expect(sockets[1]?.url).toBe(PUBLIC_SOCKET);

    connection.stop();
    await connection.done;
});

// A stop that lands while the address is still being decided has nothing to close and must open nothing after
// the fact: a socket dialled by a loop that has already reported itself done would be a connection nobody stops.
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

// Unchanged from before the resolver, and pinned because the retry path now has an await in it: a refused
// enrollment is a decision, and the loop must end rather than resolve an address for a door that is locked.
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
