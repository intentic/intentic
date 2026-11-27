import type { IngressBody, SleepHeardMessage, SleepWatch } from "@intentic/api-contract";
import { SLEEP_HEARD_MAX } from "@intentic/api-contract";
import type { PrismaClient } from "@intentic/prisma";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { Hono } from "hono";
import type { Logger } from "pino";
import type { Config } from "../../../config.js";
import { encryptSecret } from "../../../crypto.js";
import { ingressServer } from "../../../ingress.js";
import { hostedEnabled } from "../hosted.js";

/* WHAT THE PLATFORM HOLDS WHILE A HOSTED SANDBOX SLEEPS (2026-11-27), the one exception to credentials staying in the
 * sandbox. Discord pushes a mention to a bot only down a live gateway connection, so a sleeping sandbox hears none
 * unless something outside it holds that connection. The daemon hands over a bot's token right before the machine
 * stops, only for a connection whose owner turned the card's consent switch on and while a Discord automation listens
 * (sandbox system/sleep/sleep-watches.ts); the platform keeps it encrypted under SECRETS_KEY (crypto.ts, the mechanism
 * the connect token and OAuth tokens already use), and the watcher (sleep-watch-worker.ts) holds the connection.
 *
 * Deleted: at the waking daemon's first word (its announce, its alarm write, or its ask for what was heard), with the
 * sandbox (the foreign key cascades; a farewell drops them too), when Discord refuses the token, when a start is
 * refused for standing, hours or a machine that is gone, and a boot's time after a start the daemon never answered. The
 * owner turns consent off on the card, which only a running sandbox shows: the boot that ran it already dropped every
 * hold, and the next sleep hands over only the connections still consented. What was heard is kept apart, as ids only,
 * so the gateway can fetch it after the holds are gone; it is handed over once and forgotten, and kept a week at most. */

// How long after the hand-over the watcher first connects: the machine is still stopping, and a message its own gateway
// still hears must not be heard twice.
export const SLEEP_WATCH_SETTLE_MS = 20_000;
// Bots one account's sleeping sandboxes may have held at once, across all of them.
export const SLEEP_WATCHES_PER_ACCOUNT = 4;

/** Holds the connections one hosted sandbox hands over, in place of any it held; answers how many it holds. Past the
 * account's cap, the rest are refused rather than held. */
export const holdSleepWatches = async (
    prisma: PrismaClient,
    config: Config,
    sandbox: { readonly id: string; readonly ownerId: string },
    watches: readonly SleepWatch[],
    now: Date,
): Promise<number> =>
    prisma.$transaction(async (tx) => {
        await tx.sleepWatch.deleteMany({ where: { sandboxId: sandbox.id } });
        if (watches.length === 0) {
            return 0;
        }
        const others = await tx.sleepWatch.count({ where: { sandbox: { ownerId: sandbox.ownerId } } });
        const unique = [...new Map(watches.map((watch) => [watch.connection, watch])).values()];
        const held = unique.slice(0, Math.max(0, SLEEP_WATCHES_PER_ACCOUNT - others));
        const listenFrom = new Date(now.getTime() + SLEEP_WATCH_SETTLE_MS);
        await tx.sleepWatch.createMany({
            data: held.map((watch) => ({
                sandboxId: sandbox.id,
                service: watch.service,
                connection: watch.connection,
                credential: encryptSecret(config, watch.credential),
                heldAt: now,
                listenFrom,
            })),
        });
        return held.length;
    });

/** Drops every connection held for one sandbox: any word from its waking daemon, its removal. */
export const releaseSleepWatches = async (prisma: PrismaClient, sandboxId: string): Promise<number> =>
    (await prisma.sleepWatch.deleteMany({ where: { sandboxId } })).count;

/** Records where one message a held connection heard is, while it is still held; false once the hold is gone or its
 * connection has kept SLEEP_HEARD_MAX already. The same message twice is one. */
export const recordSleepHeard = async (
    prisma: PrismaClient,
    hold: { readonly id: string; readonly sandboxId: string; readonly service: string; readonly connection: string },
    message: { readonly channelId: string; readonly messageId: string; readonly guildId?: string | undefined },
    now: Date,
): Promise<boolean> =>
    prisma.$transaction(async (tx) => {
        const held = await tx.sleepWatch.findUnique({ where: { id: hold.id }, select: { id: true } });
        if (held === null) {
            return false;
        }
        const kept = await tx.sleepHeard.count({ where: { sandboxId: hold.sandboxId, connection: hold.connection } });
        if (kept >= SLEEP_HEARD_MAX) {
            return false;
        }
        await tx.sleepHeard.createMany({
            data: [
                {
                    sandboxId: hold.sandboxId,
                    service: hold.service,
                    connection: hold.connection,
                    channelId: message.channelId,
                    messageId: message.messageId,
                    guildId: message.guildId ?? null,
                    heardAt: now,
                },
            ],
            skipDuplicates: true,
        });
        return true;
    });

/** What the named connections heard while the sandbox slept, oldest first, handed over once: taking them forgets them,
 * and ends every hold of the sandbox, since its daemon is up to ask. */
export const takeSleepHeard = async (prisma: PrismaClient, sandboxId: string, connections: readonly string[]): Promise<SleepHeardMessage[]> =>
    prisma.$transaction(async (tx) => {
        await tx.sleepWatch.deleteMany({ where: { sandboxId } });
        const where = { sandboxId, connection: { in: [...connections] } };
        const rows = await tx.sleepHeard.findMany({ where, orderBy: { heardAt: "asc" } });
        await tx.sleepHeard.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
        return rows.map((row) => {
            const heard: SleepHeardMessage = {
                service: "discord",
                connection: row.connection,
                channelId: row.channelId,
                messageId: row.messageId,
                at: row.heardAt.getTime(),
            };
            return row.guildId === null ? heard : { ...heard, guildId: row.guildId };
        });
    });

type SleepWatchBody = IngressBody<"sleepWatch">;

// The hosted sandbox a connect token names, or none: a sandbox on somebody's own computer never hands anything over.
const hostedSandboxOf = (prisma: PrismaClient, token: string) =>
    prisma.sandbox.findFirst({ where: { tokenDigest: sha256Hex(token), removedAt: null, hosted: { isNot: null } }, select: { id: true, ownerId: true } });

export const sleepWatchRoutes = ({ prisma, config }: { readonly prisma: PrismaClient; readonly config: Config }) => {
    const app = new Hono<{ Variables: { logger: Logger } }>();
    const serve = ingressServer(app);
    serve("sleepWatch", async (c, kit) => {
        if (kit.connectToken === undefined) {
            return kit.refuse(400, "missing token");
        }
        const body: SleepWatchBody | undefined = await kit.body();
        if (body === undefined) {
            return kit.refuse(400, "expected the connections to hold while it sleeps");
        }
        if (body.watches.length > 0 && !hostedEnabled(config)) {
            return kit.refuse(503, "hosted sleep watches are unavailable");
        }
        const sandbox = await hostedSandboxOf(prisma, kit.connectToken);
        if (sandbox === null) {
            return kit.refuse(404, "unknown hosted sandbox");
        }
        const held = await holdSleepWatches(prisma, config, sandbox, body.watches, new Date());
        if (held < body.watches.length) {
            c.get("logger").warn({ sandboxId: sandbox.id, asked: body.watches.length, held }, "sleep watch: the account's cap left some connections unheld");
        }
        return kit.answer({ ok: true, held });
    });
    serve("sleepHeard", async (_c, kit) => {
        if (kit.connectToken === undefined) {
            return kit.refuse(400, "missing token");
        }
        const body = await kit.body();
        if (body === undefined) {
            return kit.refuse(400, "expected the connections to take what was heard for");
        }
        const sandbox = await hostedSandboxOf(prisma, kit.connectToken);
        if (sandbox === null) {
            return kit.refuse(404, "unknown hosted sandbox");
        }
        return kit.answer({ heard: await takeSleepHeard(prisma, sandbox.id, body.connections) });
    });
    return app;
};
