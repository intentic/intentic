import { ORPCError } from "@orpc/server";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { waitFor } from "@intentic/testing/bun";
import { pino } from "pino";
import { HOSTED_WAKE_BOOT_MS } from "../wake/hosted-wake-alarm.js";
import type { wakeHostedSandbox } from "../wake/hosted-wake.js";
import { fakeWakeAlarms, hostedWakeConfig, wakeAlarmRow } from "../wake/hosted-wake.testing.js";
import type { DiscordWatch, DiscordWatchHooks } from "./discord-watch.js";
import { holdSleepWatches, SLEEP_WATCH_SETTLE_MS } from "./sleep-watch.js";
import { createSleepWatcher, requestStart, type WatchStart } from "./sleep-watch-worker.js";
import { type FakeSandbox, fakeSleepWatchDb } from "./sleep-watch.testing.js";

// The watcher holds a connection per due hold, starts the sandbox once for what its bot heard (through the request
// wake's start, never as a person), lets go of a hold its daemon ended, and drops one Discord or the platform refuses.

const HELD_AT = new Date("2026-11-27T03:00:00Z");
const config = { ...hostedWakeConfig(), secrets: { key: "sleep-watch-test-key" } };
const logger = pino({ level: "silent" });
const sandbox = (id: string, ownerId = "u1"): FakeSandbox => ({ id, ownerId, tokenDigest: sha256Hex(`connect-${id}`), removedAt: null, hosted: { id: `h-${id}` } });

interface Opened {
    readonly token: string;
    readonly hooks: DiscordWatchHooks;
    closed: boolean;
}

// A watcher over the fake tables with fake connections, whose clock the test moves; `start` answers what it is told.
const setUp = async (answer: () => WatchStart = () => ({ kind: "started", settled: Promise.resolve(undefined) })) => {
    const db = fakeSleepWatchDb([sandbox("s1"), sandbox("s2")]);
    await holdSleepWatches(db.prisma, config, sandbox("s1"), [{ service: "discord", connection: "discord-team", credential: "bot-token" }], HELD_AT);
    const opened: Opened[] = [];
    let now = new Date(HELD_AT.getTime() + SLEEP_WATCH_SETTLE_MS);
    const start = jest.fn(async (_sandboxId: string, _at: Date) => answer());
    const watcher = createSleepWatcher({
        prisma: db.prisma,
        config,
        logger,
        now: () => now,
        start,
        watch: (token, hooks): DiscordWatch => {
            const entry: Opened = { token, hooks, closed: false };
            opened.push(entry);
            return {
                state: () => (entry.closed ? "stopped" : "ready"),
                close: () => {
                    entry.closed = true;
                },
            };
        },
    });
    const at = (ms: number): void => {
        now = new Date(HELD_AT.getTime() + ms);
    };
    // A message the bot heard, recorded and acted on before the test looks.
    const hear = async (messageId: string): Promise<void> => {
        opened.at(-1)?.hooks.heard({ channelId: "100", messageId, guildId: "9" });
        await waitFor(() => expect(db.heard.map((row) => row.messageId)).toContain(messageId));
    };
    return { db, opened, watcher, start, at, hear };
};

test("connects only once the hold has settled, with the token decrypted", async () => {
    const { opened, watcher, at } = await setUp();
    at(SLEEP_WATCH_SETTLE_MS - 1);
    await watcher.sync();
    expect(opened).toEqual([]);
    at(SLEEP_WATCH_SETTLE_MS);
    await watcher.sync();
    expect(opened.map((each) => each.token)).toEqual(["bot-token"]);
    await watcher.sync();
    expect(opened).toHaveLength(1);
});

test("a message for the bot is recorded and starts the sandbox once; what follows while it boots starts nothing", async () => {
    const { db, watcher, start, hear } = await setUp();
    await watcher.sync();
    await hear("1");
    await waitFor(() => expect(start.mock.calls.map(([id]) => id)).toEqual(["s1"]));
    expect(db.watches[0]?.wokeAt).not.toBeNull();
    await hear("2");
    await watcher.sync();
    expect(start).toHaveBeenCalledTimes(1);
    expect(db.heard.map((row) => [row.connection, row.channelId, row.messageId, row.guildId])).toEqual([
        ["discord-team", "100", "1", "9"],
        ["discord-team", "100", "2", "9"],
    ]);
});

test("a hold its daemon ended is let go at the next pass, and one a start left a boot's time is dropped", async () => {
    const first = await setUp();
    await first.watcher.sync();
    first.db.watches.splice(0);
    await first.watcher.sync();
    expect(first.opened[0]?.closed).toBe(true);
    expect(first.watcher.open()).toEqual([]);

    const second = await setUp();
    await second.watcher.sync();
    await second.hear("1");
    await waitFor(() => expect(second.start).toHaveBeenCalledTimes(1));
    second.at(SLEEP_WATCH_SETTLE_MS + HOSTED_WAKE_BOOT_MS + 1);
    await second.watcher.sync();
    expect(second.db.watches).toEqual([]);
    expect(second.opened[0]?.closed).toBe(true);
});

test("a start refused for good drops the sandbox's holds; one that stumbled is tried again after a backoff", async () => {
    const refused = await setUp(() => ({ kind: "started", settled: Promise.resolve(new ORPCError("PAYMENT_REQUIRED", { message: "hours spent" })) }));
    await refused.watcher.sync();
    await refused.hear("1");
    await waitFor(() => expect(refused.db.watches).toEqual([]));

    let failing = true;
    const stumbled = await setUp(() =>
        failing ? { kind: "started", settled: Promise.resolve(new ORPCError("BAD_GATEWAY", { message: "fly" })) } : { kind: "started", settled: Promise.resolve(undefined) },
    );
    await stumbled.watcher.sync();
    await stumbled.hear("1");
    await waitFor(() => expect(stumbled.db.watches[0]).toMatchObject({ wokeAt: null, failures: 1 }));
    failing = false;
    await stumbled.watcher.sync();
    expect(stumbled.start).toHaveBeenCalledTimes(1);
    stumbled.at(SLEEP_WATCH_SETTLE_MS + 60_000);
    await stumbled.watcher.sync();
    expect(stumbled.start).toHaveBeenCalledTimes(2);
});

test("the day's starts spent puts it off to the next UTC day", async () => {
    const { db, watcher, start, hear } = await setUp(() => ({ kind: "spent" }));
    await watcher.sync();
    await hear("1");
    await waitFor(() => expect(db.watches[0]).toMatchObject({ wokeAt: null, retryAt: new Date("2026-11-28T00:00:00Z") }));
    await watcher.sync();
    expect(start).toHaveBeenCalledTimes(1);
});

test("a token Discord refuses drops its hold", async () => {
    const { db, opened, watcher } = await setUp();
    await watcher.sync();
    opened[0]?.hooks.refused("Discord refused the bot token (4004)");
    await waitFor(() => expect(db.watches).toEqual([]));
    expect(watcher.open()).toEqual([]);
});

test("the production start is the request wake's: as a request, never a person, and once while it boots", async () => {
    const row = wakeAlarmRow(null, "s1");
    const { prisma } = fakeWakeAlarms([row]);
    const wake = jest.fn(async (..._args: Parameters<typeof wakeHostedSandbox>): Promise<void> => {});
    const start = requestStart({ prisma, config, logger }, wake);
    const first = await start("s1", HELD_AT);
    expect(first.kind).toBe("started");
    if (first.kind === "started") {
        expect(await first.settled).toBeUndefined();
    }
    expect(wake.mock.calls.map(([, woken, cause]) => [woken.id, cause])).toEqual([["s1", "request"]]);
    expect(row.requestWakeAt).toEqual(HELD_AT);
    expect(row.personSeenAt).toBeNull();
    expect((await start("s1", new Date(HELD_AT.getTime() + 1_000))).kind).toBe("booting");
    expect((await start("nobody", HELD_AT)).kind).toBe("gone");
});
