import { CONNECT_TOKEN_HEADER, SLEEP_HEARD_MAX } from "@intentic/api-contract";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { Hono } from "hono";
import { pino } from "pino";
import { decryptSecret } from "../../../crypto.js";
import { hostedWakeConfig } from "../wake/hosted-wake.testing.js";
import { holdSleepWatches, recordSleepHeard, SLEEP_WATCH_SETTLE_MS, SLEEP_WATCHES_PER_ACCOUNT, sleepWatchRoutes, takeSleepHeard } from "./sleep-watch.js";
import { type FakeSandbox, fakeSleepWatchDb } from "./sleep-watch.testing.js";

// What the platform holds while a hosted sandbox sleeps: a bot's token, encrypted, only for a hosted sandbox, at most
// SLEEP_WATCHES_PER_ACCOUNT an account, in place of whatever the sandbox held before, and let go at its daemon's word.
// What it heard is ids only, handed over once.

const NOW = new Date("2026-11-27T03:00:00Z");
const config = { ...hostedWakeConfig(), secrets: { key: "sleep-watch-test-key" } };
const logger = pino({ level: "silent" });
const sandbox = (id: string, ownerId = "u1", hosted = true): FakeSandbox => ({
    id,
    ownerId,
    tokenDigest: sha256Hex(`connect-${id}`),
    removedAt: null,
    hosted: hosted ? { id: `h-${id}` } : null,
});
const bot = (connection: string, credential = `token-${connection}`) => ({ service: "discord" as const, connection, credential });

describe("holding connections while a sandbox sleeps", () => {
    test("keeps each token encrypted, and first listens once the machine has had time to stop", async () => {
        const db = fakeSleepWatchDb([sandbox("s1")]);
        expect(await holdSleepWatches(db.prisma, config, sandbox("s1"), [bot("discord-team")], NOW)).toBe(1);
        const [row] = db.watches;
        expect(row?.credential).toStartWith("enc1:");
        expect(row?.credential).not.toContain("token-discord-team");
        expect(decryptSecret(config, row?.credential ?? "")).toBe("token-discord-team");
        expect(row?.listenFrom).toEqual(new Date(NOW.getTime() + SLEEP_WATCH_SETTLE_MS));
    });

    test("a hand-over replaces what the sandbox held, and an empty one drops it all", async () => {
        const db = fakeSleepWatchDb([sandbox("s1")]);
        await holdSleepWatches(db.prisma, config, sandbox("s1"), [bot("a"), bot("b")], NOW);
        await holdSleepWatches(db.prisma, config, sandbox("s1"), [bot("b")], NOW);
        expect(db.watches.map((row) => row.connection)).toEqual(["b"]);
        expect(await holdSleepWatches(db.prisma, config, sandbox("s1"), [], NOW)).toBe(0);
        expect(db.watches).toEqual([]);
    });

    test("an account's sandboxes hold at most its cap between them", async () => {
        const db = fakeSleepWatchDb([sandbox("s1"), sandbox("s2"), sandbox("other", "u2")]);
        expect(await holdSleepWatches(db.prisma, config, sandbox("s1"), [bot("a"), bot("b"), bot("c")], NOW)).toBe(3);
        expect(await holdSleepWatches(db.prisma, config, sandbox("s2"), [bot("d"), bot("e")], NOW)).toBe(SLEEP_WATCHES_PER_ACCOUNT - 3);
        expect(await holdSleepWatches(db.prisma, config, sandbox("other", "u2"), [bot("f")], NOW)).toBe(1);
    });
});

describe("what a held connection heard", () => {
    const hold = async () => {
        const db = fakeSleepWatchDb([sandbox("s1")]);
        await holdSleepWatches(db.prisma, config, sandbox("s1"), [bot("discord-team"), bot("discord-ops")], NOW);
        const held = (connection: string) => {
            const row = db.watches.find((each) => each.connection === connection);
            if (row === undefined) {
                throw new Error(`nothing held for ${connection}`);
            }
            return row;
        };
        return { db, held };
    };

    test("is recorded once per message, only while held, up to the connection's cap", async () => {
        const { db, held } = await hold();
        const team = held("discord-team");
        expect(await recordSleepHeard(db.prisma, team, { channelId: "100", messageId: "1", guildId: "9" }, NOW)).toBe(true);
        expect(await recordSleepHeard(db.prisma, team, { channelId: "100", messageId: "1", guildId: "9" }, NOW)).toBe(true);
        expect(db.heard).toHaveLength(1);
        for (let message = 2; message <= SLEEP_HEARD_MAX + 1; message++) {
            await recordSleepHeard(db.prisma, team, { channelId: "100", messageId: String(message) }, NOW);
        }
        expect(db.heard).toHaveLength(SLEEP_HEARD_MAX);
        db.watches.splice(0);
        expect(await recordSleepHeard(db.prisma, team, { channelId: "100", messageId: "77" }, NOW)).toBe(false);
    });

    test("is handed over once for the connections asked, oldest first, and asking lets every hold go", async () => {
        const { db, held } = await hold();
        await recordSleepHeard(db.prisma, held("discord-team"), { channelId: "100", messageId: "2", guildId: "9" }, new Date(NOW.getTime() + 2_000));
        await recordSleepHeard(db.prisma, held("discord-team"), { channelId: "200", messageId: "1" }, new Date(NOW.getTime() + 1_000));
        await recordSleepHeard(db.prisma, held("discord-ops"), { channelId: "300", messageId: "3", guildId: "9" }, NOW);
        expect(await takeSleepHeard(db.prisma, "s1", ["discord-team"])).toEqual([
            { service: "discord", connection: "discord-team", channelId: "200", messageId: "1", at: NOW.getTime() + 1_000 },
            { service: "discord", connection: "discord-team", channelId: "100", messageId: "2", guildId: "9", at: NOW.getTime() + 2_000 },
        ]);
        expect(db.watches).toEqual([]);
        expect(await takeSleepHeard(db.prisma, "s1", ["discord-team"])).toEqual([]);
        expect(db.heard.map((row) => row.connection)).toEqual(["discord-ops"]);
    });
});

describe("the daemon's routes", () => {
    const routes = (rows: FakeSandbox[]) => {
        const db = fakeSleepWatchDb(rows);
        const app = new Hono<{ Variables: { logger: typeof logger } }>();
        app.use(async (c, next) => {
            c.set("logger", logger);
            await next();
        });
        app.route("/", sleepWatchRoutes({ prisma: db.prisma, config }));
        const post = (path: string, id: string, body: object) =>
            app.request(path, { method: "POST", headers: { "content-type": "application/json", [CONNECT_TOKEN_HEADER]: `connect-${id}` }, body: JSON.stringify(body) });
        return { db, post };
    };

    test("a hosted sandbox hands its bots over and is told how many are held", async () => {
        const { db, post } = routes([sandbox("s1")]);
        const res = await post("/sandbox/sleep-watch", "s1", { watches: [bot("discord-team")] });
        expect(await res.json()).toEqual({ ok: true, held: 1 });
        expect(db.watches).toHaveLength(1);
    });

    test("a sandbox on somebody's own computer, or one removed, hands nothing over", async () => {
        const removed = { ...sandbox("gone"), removedAt: NOW };
        const { db, post } = routes([sandbox("local", "u1", false), removed]);
        expect((await post("/sandbox/sleep-watch", "local", { watches: [bot("discord-team")] })).status).toBe(404);
        expect((await post("/sandbox/sleep-watch", "gone", { watches: [bot("discord-team")] })).status).toBe(404);
        expect((await post("/sandbox/sleep-watch", "nobody", { watches: [bot("discord-team")] })).status).toBe(404);
        expect(db.watches).toEqual([]);
    });

    test("a malformed hand-over is refused whole, never trimmed", async () => {
        const { db, post } = routes([sandbox("s1")]);
        expect((await post("/sandbox/sleep-watch", "s1", { watches: [{ ...bot("x"), service: "slack" }] })).status).toBe(400);
        expect(db.watches).toEqual([]);
    });

    test("asking what was heard answers it once and lets the holds go", async () => {
        const { db, post } = routes([sandbox("s1")]);
        await post("/sandbox/sleep-watch", "s1", { watches: [bot("discord-team")] });
        const [row] = db.watches;
        if (row === undefined) {
            throw new Error("nothing held");
        }
        await recordSleepHeard(db.prisma, row, { channelId: "100", messageId: "1", guildId: "9" }, NOW);
        const first = await (await post("/sandbox/sleep-watch/heard", "s1", { connections: ["discord-team"] })).json();
        expect(first).toEqual({ heard: [{ service: "discord", connection: "discord-team", channelId: "100", messageId: "1", guildId: "9", at: NOW.getTime() }] });
        expect(db.watches).toEqual([]);
        expect(await (await post("/sandbox/sleep-watch/heard", "s1", { connections: ["discord-team"] })).json()).toEqual({ heard: [] });
    });
});
