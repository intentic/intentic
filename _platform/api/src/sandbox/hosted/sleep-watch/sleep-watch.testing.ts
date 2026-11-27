import type { PrismaClient } from "@intentic/prisma";
import { unstubbed } from "@intentic/testing";
import type { GatewaySocket, OpenSocket, SocketEvents } from "./discord-watch.js";

/* The sleep watch's seams, faked once: its two tables beside the sandboxes they hang off (only the query shapes
 * sleep-watch.ts and the worker use), and a Discord gateway a test drives frame by frame. */

export interface FakeSandbox {
    readonly id: string;
    readonly ownerId: string;
    readonly tokenDigest: string;
    removedAt: Date | null;
    hosted: object | null;
}

export interface WatchRow {
    id: string;
    sandboxId: string;
    service: string;
    connection: string;
    credential: string;
    heardAt?: never;
    heldAt: Date;
    listenFrom: Date;
    wokeAt: Date | null;
    retryAt: Date | null;
    failures: number;
}

export interface HeardRow {
    id: string;
    sandboxId: string;
    service: string;
    connection: string;
    channelId: string;
    messageId: string;
    guildId: string | null;
    heardAt: Date;
}

type DateQuery = Date | null | { readonly lte?: Date; readonly lt?: Date; readonly not?: null };
interface SandboxQuery {
    readonly ownerId?: string;
    readonly tokenDigest?: string;
    readonly removedAt?: DateQuery;
    readonly hosted?: null | { readonly isNot: null };
}
interface WatchQuery {
    readonly id?: string | { readonly in: readonly string[] };
    readonly sandboxId?: string | { readonly in: readonly string[] };
    readonly service?: string;
    readonly connection?: string | { readonly in: readonly string[] };
    readonly listenFrom?: DateQuery;
    readonly wokeAt?: DateQuery;
    readonly retryAt?: DateQuery;
    readonly heardAt?: DateQuery;
    readonly sandbox?: SandboxQuery;
    readonly OR?: readonly WatchQuery[];
}

const dateIs = (value: Date | null, asked: DateQuery | undefined): boolean => {
    if (asked === undefined) {
        return true;
    }
    if (asked === null) {
        return value === null;
    }
    if ("not" in asked) {
        return value !== null;
    }
    if (value === null) {
        return false;
    }
    if (asked instanceof Date) {
        return value.getTime() === asked.getTime();
    }
    return (asked.lte === undefined || value <= asked.lte) && (asked.lt === undefined || value < asked.lt);
};

const oneOf = (value: string, asked: string | { readonly in: readonly string[] } | undefined): boolean =>
    asked === undefined || (asked instanceof Object ? asked.in.includes(value) : value === asked);

const sandboxIs = (sandbox: FakeSandbox | undefined, asked: SandboxQuery | undefined): boolean =>
    asked === undefined ||
    (sandbox !== undefined &&
        (asked.ownerId === undefined || sandbox.ownerId === asked.ownerId) &&
        (asked.tokenDigest === undefined || sandbox.tokenDigest === asked.tokenDigest) &&
        dateIs(sandbox.removedAt, asked.removedAt) &&
        (asked.hosted === undefined || (asked.hosted === null ? sandbox.hosted === null : sandbox.hosted !== null)));

export const fakeSleepWatchDb = (sandboxes: FakeSandbox[]) => {
    const watches: WatchRow[] = [];
    const heard: HeardRow[] = [];
    let ids = 0;
    const sandboxOf = (id: string) => sandboxes.find((sandbox) => sandbox.id === id);
    const matches = (row: WatchRow | HeardRow, where: WatchQuery = {}): boolean =>
        oneOf(row.id, where.id) &&
        oneOf(row.sandboxId, where.sandboxId) &&
        (where.service === undefined || row.service === where.service) &&
        oneOf(row.connection, where.connection) &&
        ("listenFrom" in row ? dateIs(row.listenFrom, where.listenFrom) && dateIs(row.wokeAt, where.wokeAt) && dateIs(row.retryAt, where.retryAt) : true) &&
        ("heardAt" in row && row.heardAt !== undefined ? dateIs(row.heardAt, where.heardAt) : true) &&
        sandboxIs(sandboxOf(row.sandboxId), where.sandbox) &&
        (where.OR === undefined || where.OR.some((branch) => matches(row, branch)));
    const remove = <T extends WatchRow | HeardRow>(rows: T[], where: WatchQuery) => {
        const gone = rows.filter((row) => matches(row, where));
        for (const row of gone) {
            rows.splice(rows.indexOf(row), 1);
        }
        return { count: gone.length };
    };
    const sleepWatch = {
        deleteMany: jest.fn(async ({ where }: { where: WatchQuery }) => remove(watches, where)),
        count: jest.fn(async ({ where }: { where: WatchQuery }) => watches.filter((row) => matches(row, where)).length),
        createMany: jest.fn(async ({ data }: { data: Omit<WatchRow, "id" | "wokeAt" | "retryAt" | "failures">[] }) => {
            for (const row of data) {
                watches.push({ id: `w${++ids}`, wokeAt: null, retryAt: null, failures: 0, ...row });
            }
            return { count: data.length };
        }),
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => watches.find((row) => row.id === where.id) ?? null),
        findFirst: jest.fn(async ({ where }: { where: WatchQuery }) => watches.find((row) => matches(row, where)) ?? null),
        findMany: jest.fn(async ({ where, take }: { where: WatchQuery; take?: number }) =>
            watches
                .filter((row) => matches(row, where))
                .toSorted((a, b) => a.heldAt.getTime() - b.heldAt.getTime())
                .slice(0, take)
                .map((row) => ({ ...row, sandbox: { ownerId: sandboxOf(row.sandboxId)?.ownerId ?? "" } })),
        ),
        updateMany: jest.fn(async ({ where, data }: { where: WatchQuery; data: Partial<WatchRow> }) => {
            const matched = watches.filter((row) => matches(row, where));
            for (const row of matched) {
                Object.assign(row, data);
            }
            return { count: matched.length };
        }),
    };
    const sleepHeard = {
        count: jest.fn(async ({ where }: { where: WatchQuery }) => heard.filter((row) => matches(row, where)).length),
        createMany: jest.fn(async ({ data }: { data: Omit<HeardRow, "id">[]; skipDuplicates: boolean }) => {
            const fresh = data.filter(
                (row) => !heard.some((kept) => kept.sandboxId === row.sandboxId && kept.connection === row.connection && kept.messageId === row.messageId),
            );
            for (const row of fresh) {
                heard.push({ id: `h${++ids}`, ...row });
            }
            return { count: fresh.length };
        }),
        findMany: jest.fn(async ({ where, distinct }: { where: WatchQuery; distinct?: readonly string[] }) => {
            const rows = heard.filter((row) => matches(row, where)).toSorted((a, b) => a.heardAt.getTime() - b.heardAt.getTime());
            return distinct === undefined ? rows : rows.filter((row, index) => rows.findIndex((other) => other.sandboxId === row.sandboxId) === index);
        }),
        deleteMany: jest.fn(async ({ where }: { where: WatchQuery }) => remove(heard, where)),
    };
    // The routes' read of the sandbox a connect token names.
    const sandbox = {
        findFirst: jest.fn(async ({ where }: { where: SandboxQuery }) => {
            const found = sandboxes.find((row) => sandboxIs(row, where));
            return found === undefined ? null : { id: found.id, ownerId: found.ownerId };
        }),
    };
    const client = { sleepWatch, sleepHeard };
    const transaction = async <T>(run: (tx: typeof client) => Promise<T>): Promise<T> => run(client);
    // SAFETY: the sleep watch reaches only these two tables, in the query shapes above, and a transaction over them.
    const prisma = unstubbed<PrismaClient>("prisma", {
        sandbox: sandbox as never,
        sleepWatch: sleepWatch as never,
        sleepHeard: sleepHeard as never,
        $transaction: transaction as never,
    });
    return { prisma, watches, heard, sleepWatch, sleepHeard };
};

/* A Discord gateway one test drives: every socket the watch opened, what it sent, and the frames to answer with. */
export type GatewayValue = string | number | boolean | null | readonly GatewayValue[] | GatewayPayload;
export interface GatewayPayload {
    readonly [key: string]: GatewayValue;
}
export interface SentFrame {
    readonly op: number;
    readonly d: GatewayValue;
}
export interface FakeSocket {
    readonly url: string;
    readonly sent: SentFrame[];
    closedWith?: number;
    readonly events: SocketEvents;
}

export const fakeGateway = () => {
    const sockets: FakeSocket[] = [];
    const open: OpenSocket = (url, events): GatewaySocket => {
        const socket: FakeSocket = { url, sent: [], events };
        sockets.push(socket);
        return {
            // SAFETY: the watch sends nothing but `{ op, d }` frames it built with JSON.stringify.
            send: (text) => void socket.sent.push(JSON.parse(text) as SentFrame),
            close: (code) => {
                socket.closedWith = code;
            },
        };
    };
    const last = (): FakeSocket => {
        const socket = sockets.at(-1);
        if (socket === undefined) {
            throw new Error("the watch opened no socket");
        }
        return socket;
    };
    const say = (frame: { op: number; d?: GatewayValue; s?: number; t?: string }): void => last().events.message(JSON.stringify({ d: null, ...frame }));
    return {
        open,
        sockets,
        last,
        say,
        hello: (intervalMs = 41_250) => say({ op: 10, d: { heartbeat_interval: intervalMs } }),
        ready: (botId = "999", s = 1) =>
            say({ op: 0, t: "READY", s, d: { session_id: "session-1", resume_gateway_url: "wss://resume.discord.gg", user: { id: botId } } }),
        dispatch: (t: string, d: GatewayPayload, s?: number) => say(s === undefined ? { op: 0, t, d } : { op: 0, t, d, s }),
        close: (code: number) => last().events.closed(code),
    };
};

/* A clock a test advances by hand: what the watch scheduled, run when the test says. */
export const manualClock = () => {
    let now = 0;
    const pending: { at: number; fn: () => void; cancelled: boolean }[] = [];
    return {
        after: (ms: number, fn: () => void) => {
            const timer = { at: now + ms, fn, cancelled: false };
            pending.push(timer);
            return () => {
                timer.cancelled = true;
            };
        },
        advance: (ms: number) => {
            const until = now + ms;
            for (;;) {
                const next = pending.filter((timer) => !timer.cancelled && timer.at <= until).toSorted((a, b) => a.at - b.at)[0];
                if (next === undefined) {
                    break;
                }
                now = next.at;
                next.cancelled = true;
                next.fn();
            }
            now = until;
        },
    };
};
