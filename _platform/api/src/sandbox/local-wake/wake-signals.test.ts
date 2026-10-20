import { EventEmitter } from "node:events";
import { waitFor } from "@intentic/testing/bun";
import pino from "pino";
import { configSchema } from "../../config.js";
import { type ListenClient, LISTEN_RETRY_FIRST_MS, localWakeSignals, startWakeSignals, WAKE_CHANNEL, type WakeSignals } from "./wake-signals.js";

const A = `aaaaaaaaaaaa`;
const B = `bbbbbbbbbbbb`;

// Every way a wait ends leaves nothing registered (`waiting`): a held ask that left its waiter behind would be fired
// forever after, and a replica would keep every ask it ever held.
describe(`a wait for a wake, in one process`, () => {
    it(`ends on a signal for its sandbox, and a signal for another sandbox ends nothing of it`, async () => {
        const hub = localWakeSignals();
        const onA = hub.wait([A], 5000);
        const onB = hub.wait([B], 5000);
        hub.fire(A);
        expect(await onA).toBe(`signal`);
        expect(hub.waiting()).toBe(1);
        hub.fire(B);
        expect(await onB).toBe(`signal`);
        expect(hub.waiting()).toBe(0);
    });

    it(`waits on several sandboxes at once, ends on any of them, and leaves every one`, async () => {
        const hub = localWakeSignals();
        const either = hub.wait([A, B, A], 5000);
        expect(hub.waiting()).toBe(1);
        hub.fire(B);
        expect(await either).toBe(`signal`);
        expect(hub.waiting()).toBe(0);
        // The other id, fired after the wait ended, finds nobody under it.
        const onA = hub.wait([A], 5000);
        hub.fire(A);
        expect(await onA).toBe(`signal`);
        expect(hub.waiting()).toBe(0);
    });

    it(`hears a signal sent between the call and the await`, async () => {
        const hub = localWakeSignals();
        const wait = hub.wait([A], 5000);
        hub.fire(A);
        expect(await wait).toBe(`signal`);
        expect(hub.waiting()).toBe(0);
    });

    it(`ends at its time, and a signal after that finds nobody`, async () => {
        const hub = localWakeSignals();
        expect(await hub.wait([A], 20)).toBe(`timeout`);
        expect(hub.waiting()).toBe(0);
        hub.fire(A);
        expect(hub.waiting()).toBe(0);
    });

    it(`ends on its abort signal, and an abort that came first registers nothing`, async () => {
        const hub = localWakeSignals();
        const gone = new AbortController();
        const wait = hub.wait([A], 5000, gone.signal);
        gone.abort();
        expect(await wait).toBe(`abort`);
        expect(hub.waiting()).toBe(0);
        const late = hub.wait([A], 5000, gone.signal);
        expect(hub.waiting()).toBe(0);
        expect(await late).toBe(`abort`);
    });

    it(`ends once: an abort after the signal changes nothing`, async () => {
        const hub = localWakeSignals();
        const gone = new AbortController();
        const wait = hub.wait([A], 5000, gone.signal);
        hub.fire(A);
        gone.abort();
        expect(await wait).toBe(`signal`);
        expect(hub.waiting()).toBe(0);
    });

    it(`stopped, ends every wait as aborted and holds no new one`, async () => {
        const hub = localWakeSignals();
        const held = hub.wait([A], 5000);
        await hub.stop();
        expect(await held).toBe(`abort`);
        const late = hub.wait([A], 5000);
        expect(hub.waiting()).toBe(0);
        expect(await late).toBe(`abort`);
    });

    it(`says a notify to this process's waiters`, async () => {
        const hub = localWakeSignals();
        const wait = hub.wait([A], 5000);
        await hub.notify(A);
        expect(await wait).toBe(`signal`);
        expect(hub.waiting()).toBe(0);
    });
});

// A `pg` client as the listener drives it: connects or refuses, records what it was asked, and ends once.
class FakeListenClient extends EventEmitter implements ListenClient {
    readonly queries: string[] = [];
    ended = false;
    constructor(private readonly refusal?: Error) {
        super();
    }
    async connect(): Promise<void> {
        if (this.refusal !== undefined) {
            throw this.refusal;
        }
    }
    async query(text: string): Promise<object> {
        this.queries.push(text);
        return {};
    }
    async end(): Promise<void> {
        if (!this.ended) {
            this.ended = true;
            this.emit(`end`);
        }
    }
}

const config = configSchema.parse({
    database: { url: `postgres://x`, poolMax: 10 },
    betterAuth: { secret: `s` },
    secrets: { key: `` },
    webOrigin: `https://app.test`,
});

// A logger that keeps what it was told, by level (pino's numbers: 30 info, 40 warn).
const recording = () => {
    const lines: { level: number; msg: string }[] = [];
    const logger = pino({ level: `info` }, { write: (line: string) => lines.push(JSON.parse(line)) });
    return { logger, said: (level: number) => lines.filter((line) => line.level === level).length };
};
const INFO = 30;
const WARN = 40;

describe(`a wait for a wake, across replicas`, () => {
    let hub: WakeSignals | undefined;
    afterEach(async () => {
        await hub?.stop();
        hub = undefined;
    });

    // The clients the hub asked for, each refusing to connect when `refusals` says so, in order.
    const clientsFor = (refusals: (Error | undefined)[] = []) => {
        const clients: FakeListenClient[] = [];
        const connect = (): ListenClient => {
            const client = new FakeListenClient(refusals.shift());
            clients.push(client);
            return client;
        };
        return { clients, connect };
    };
    const listening = (client: FakeListenClient | undefined) => expect(client?.queries).toEqual([`LISTEN ${WAKE_CHANNEL}`]);

    it(`ends the waits on the sandbox a notification on its channel names, and no other channel's`, async () => {
        const { clients, connect } = clientsFor();
        hub = startWakeSignals({ config, prisma: { $executeRaw: jest.fn() }, logger: recording().logger, connect });
        await waitFor(() => listening(clients[0]));
        const wait = hub.wait([A], 5000);
        clients[0]?.emit(`notification`, { channel: `elsewhere`, payload: A, processId: 1 });
        expect(hub.waiting()).toBe(1);
        clients[0]?.emit(`notification`, { channel: WAKE_CHANNEL, payload: A, processId: 1 });
        expect(await wait).toBe(`signal`);
    });

    it(`notifies this process and Postgres, and never fails the caller when Postgres refuses`, async () => {
        const { clients, connect } = clientsFor();
        const log = recording();
        const executeRaw = jest.fn().mockRejectedValueOnce(new Error(`database unreachable`)).mockResolvedValueOnce(1);
        hub = startWakeSignals({ config, prisma: { $executeRaw: executeRaw }, logger: log.logger, connect });
        await waitFor(() => listening(clients[0]));
        const wait = hub.wait([A], 5000);
        expect(await hub.notify(A)).toBeUndefined();
        expect(await wait).toBe(`signal`);
        expect(log.said(WARN)).toBe(1);
        await hub.notify(B);
        // pg_notify with the channel and the tunnel id as its two parameters.
        const [sql, ...values] = executeRaw.mock.calls[1] ?? [];
        expect(values).toEqual([WAKE_CHANNEL, B]);
        expect([...sql].join(`?`)).toBe(`SELECT pg_notify(?, ?)`);
    });

    it(`listens again after losing its connection, says so once each way, and has every waiter look on coming back`, async () => {
        const { clients, connect } = clientsFor([new Error(`the database is starting up`)]);
        const log = recording();
        hub = startWakeSignals({ config, prisma: { $executeRaw: jest.fn() }, logger: log.logger, connect });
        // Refused at boot: said once, and asked again after the first backoff.
        await waitFor(() => expect(log.said(WARN)).toBe(1));
        const heldWhileDown = hub.wait([A], 10_000);
        await waitFor(() => listening(clients[1]), { timeout: LISTEN_RETRY_FIRST_MS * 3 });
        expect(log.said(INFO)).toBe(1);
        // A notification may have been missed while it was not listening, so every waiter looks.
        expect(await heldWhileDown).toBe(`signal`);
        // The connection dies: an error and an end, said once, and the backoff starts over from the first step.
        clients[1]?.emit(`error`, new Error(`terminating connection due to administrator command`));
        expect(clients[1]?.ended).toBe(true);
        expect(log.said(WARN)).toBe(2);
        await waitFor(() => listening(clients[2]), { timeout: LISTEN_RETRY_FIRST_MS * 3 });
        expect(log.said(INFO)).toBe(2);
        expect(clients).toHaveLength(3);
    });

    it(`stops: ends its connection and never listens again`, async () => {
        const { clients, connect } = clientsFor();
        const started = startWakeSignals({ config, prisma: { $executeRaw: jest.fn() }, logger: recording().logger, connect });
        await waitFor(() => listening(clients[0]));
        clients[0]?.emit(`error`, new Error(`connection reset`));
        await started.stop();
        await new Promise((resolve) => setTimeout(resolve, LISTEN_RETRY_FIRST_MS + 200));
        expect(clients).toHaveLength(1);
    });
});
