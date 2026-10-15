import type { PrismaClient } from "@intentic/prisma";
import { Hono } from "hono";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import { ingressServer } from "../ingress.js";
import { mintSandbox } from "../sandbox/mint-sandbox.js";
import { trashSandbox } from "../sandbox/sandbox-trash.js";
import { mintSetupCodeFor, ReachabilityUnavailable } from "../sandbox/setup-code.js";
import { bearerOf, verifyApiToken, type VerifiedToken } from "../tokens/api-tokens.js";

// THE PROVISIONING DOOR: what an agent inside one sandbox may do to the account that owns it. Authenticated by an
// account-scoped API token rather than a session, which is the whole point — every other account-level route needs a
// browser, and that is why an agent that needed a new sandbox could only ever ask a person to go and fetch a code.
//
// Four calls and no more. It creates rows and claims, and takes a row back to the trash; it never creates or deletes
// MACHINES. Hosted provisioning stays behind a session on purpose: that lane spends plan slots and real minutes, and a
// credential that lives in a container is the wrong thing to put in front of it. The daemon raises the owner's card
// before it calls either of the two that change anything.

// A session is a person clicking; a token is a loop. The browser's own create is deliberately unlimited, and this is
// not: a runaway agent, or a stolen token, buys an hour of rows rather than a database full of them.
const PROVISION_WINDOW_MS = 60 * 60 * 1000;
const PROVISION_PER_WINDOW = 10;

const REVOKED = `that provisioning token was revoked or never existed`;

export interface FleetDeps {
    readonly config: Config;
    readonly prisma: PrismaClient;
    readonly now?: () => Date;
    // The app's own delete (sandbox-trash.ts): the row to the trash, restorable for the recovery window.
    readonly trash?: (sandboxId: string, logger: Logger) => Promise<{ readonly purgeAfter: Date }>;
}

export const fleetHttpRoutes = ({
    config,
    prisma,
    now = () => new Date(),
    trash = (sandboxId, logger) => trashSandbox(prisma, config, logger, sandboxId),
}: FleetDeps) => {
    const app = new Hono<{ Variables: { logger: Logger } }>();
    const ingress = ingressServer(app, `/fleet`);

    // 401 rather than 404: unlike a sandbox's connect token, the holder here knows it is presenting a credential and
    // the useful answer is "that one does not work", which is what sends them to the Tokens page.
    const callerOf = async (c: { req: { header: (name: string) => string | undefined } }): Promise<VerifiedToken | undefined> =>
        await verifyApiToken(prisma, bearerOf(c.req.header(`authorization`)), `provision`);

    /* Whether the token still names an account. The probe behind the `fleet` capability's status row. */
    ingress(`fleetWhoami`, async (c, kit) => {
        const caller = await callerOf(c);
        return caller === undefined ? kit.refuse(401, REVOKED) : kit.answer({ email: caller.email, label: caller.label });
    });

    /* The account's sandboxes, addressing only: what an agent needs to say what exists and what has never come up. */
    ingress(`fleetSandboxes`, async (c, kit) => {
        const caller = await callerOf(c);
        if (caller === undefined) {
            return kit.refuse(401, REVOKED);
        }
        const rows = await prisma.sandbox.findMany({
            where: { ownerId: caller.userId, removedAt: null },
            select: { id: true, name: true, daemonUrl: true, lastSeenAt: true },
            orderBy: { createdAt: `asc` },
        });
        return kit.answer({
            sandboxes: rows.map((row) => ({
                id: row.id,
                name: row.name,
                ...(row.daemonUrl === null ? {} : { url: row.daemonUrl }),
                ...(row.lastSeenAt === null ? {} : { lastSeenAt: row.lastSeenAt.toISOString() }),
            })),
        });
    });

    /*
     * One sandbox's row and the claim that brings it up. The claim is spent by `ic sandbox connect` on a machine the
     * owner has connected, once, within the half hour the code lives — the same claim, byte for byte, that the setup
     * wizard mints, because both doors mint through sandbox/setup-code.ts.
     */
    ingress(`fleetProvision`, async (c, kit) => {
        const caller = await callerOf(c);
        if (caller === undefined) {
            return kit.refuse(401, REVOKED);
        }
        const parsed = await kit.body();
        if (parsed === undefined) {
            return kit.refuse(400, `the provision body must be {"name":"…"} with an optional "definition" of TOML`);
        }
        const since = new Date(now().getTime() - PROVISION_WINDOW_MS);
        const recent = await prisma.sandbox.count({ where: { ownerId: caller.userId, createdAt: { gt: since } } });
        if (recent >= PROVISION_PER_WINDOW) {
            return kit.refuse(429, `this account has created ${recent} sandboxes in the last hour; provisioning is paused until that window passes`);
        }
        const { sandbox } = await mintSandbox(prisma, config, { name: parsed.name, ownerId: caller.userId });
        try {
            // The body carries TOML; the seed is base64, the encoding the daemon decodes and every profile seed uses.
            const { definition } = parsed;
            const definitionSeed = definition === undefined ? undefined : Buffer.from(definition, `utf8`).toString(`base64`);
            const minted = await mintSetupCodeFor(prisma, config, sandbox, { ownerEmail: caller.email, definitionSeed });
            return kit.answer({ sandboxId: sandbox.id, name: sandbox.name, hostname: minted.hostname, setupCode: minted.code, expiresAt: minted.expiresAt });
        } catch (error) {
            // The row exists and cannot be claimed, which is worse than never having made it: take it back out rather
            // than leaving an unreachable name in the owner's switcher.
            await prisma.sandbox
                .delete({ where: { id: sandbox.id } })
                .catch((deleteError: unknown) =>
                    c.get(`logger`).error({ err: deleteError, sandboxId: sandbox.id }, `fleet provision: an unclaimable sandbox could not be taken back out`),
                );
            if (error instanceof ReachabilityUnavailable) {
                return kit.refuse(503, error.message);
            }
            c.get(`logger`).warn({ err: error, ownerId: caller.userId }, `fleet provision failed`);
            return kit.refuse(502, error instanceof Error ? error.message : `the sandbox could not be prepared`);
        }
    });

    /*
     * One of the account's own-machine sandboxes to the trash, as the app's delete sends it: its name and address go, and
     * the owner restores it from Recently deleted within the recovery window. A hosted one is refused, as creating one
     * is: that machine is a plan's, removed by a person in the app. A container still running it on a machine is the
     * daemon's to remove there first; this is for the row alone, a sandbox that never came up included.
     */
    ingress(`fleetRemove`, async (c, kit) => {
        const caller = await callerOf(c);
        if (caller === undefined) {
            return kit.refuse(401, REVOKED);
        }
        const parsed = await kit.body();
        if (parsed === undefined) {
            return kit.refuse(400, `the remove body must be {"sandboxId":"…"}, an id the sandbox list names`);
        }
        const sandbox = await prisma.sandbox.findFirst({
            where: { id: parsed.sandboxId, ownerId: caller.userId, removedAt: null },
            select: { id: true, name: true, hosted: { select: { appName: true } } },
        });
        if (sandbox === null) {
            return kit.refuse(404, `this account has no sandbox ${parsed.sandboxId}`);
        }
        if (sandbox.hosted !== null) {
            return kit.refuse(403, `"${sandbox.name}" is a hosted sandbox: only a person removes one, in the app`);
        }
        const { purgeAfter } = await trash(sandbox.id, c.get(`logger`));
        c.get(`logger`).info({ sandboxId: sandbox.id, ownerId: caller.userId }, `fleet: a sandbox was moved to the trash`);
        return kit.answer({ name: sandbox.name, recoverableUntil: purgeAfter.toISOString() });
    });

    return app;
};
