import type { PrismaClient } from "@intentic/prisma";
import { Hono } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import type { Config } from "../config.js";
import { mintSandbox } from "../sandbox/mint-sandbox.js";
import { mintSetupCodeFor, ReachabilityUnavailable } from "../sandbox/setup-code.js";
import { bearerOf, verifyApiToken, type VerifiedToken } from "../tokens/api-tokens.js";

// THE PROVISIONING DOOR: what an agent inside one sandbox may do to the account that owns it. Authenticated by an
// account-scoped API token rather than a session, which is the whole point — every other account-level route needs a
// browser, and that is why an agent that needed a new sandbox could only ever ask a person to go and fetch a code.
//
// Three calls and no more. It creates rows and claims; it never creates MACHINES. Hosted provisioning stays behind a
// session on purpose: that lane spends plan slots and real minutes, and a credential that lives in a container is the
// wrong thing to put in front of it.

// A sandbox's name as it appears in the switcher; the same bound the browser's own form uses.
const NameSchema = z.string().trim().min(1).max(60);

// A sandbox.toml is a document a person wrote, and this is the ceiling where one stops being that. It rides into the
// container as an env value, so an unbounded one would be refused later, further from whoever sent it.
const DEFINITION_MAX_BYTES = 64 * 1024;

const ProvisionSchema = z.object({
    name: NameSchema,
    definition: z.string().max(DEFINITION_MAX_BYTES).optional(),
});

// A session is a person clicking; a token is a loop. The browser's own create is deliberately unlimited, and this is
// not: a runaway agent, or a stolen token, buys an hour of rows rather than a database full of them.
const PROVISION_WINDOW_MS = 60 * 60 * 1000;
const PROVISION_PER_WINDOW = 10;

export interface FleetDeps {
    readonly config: Config;
    readonly prisma: PrismaClient;
    readonly now?: () => Date;
}

export const fleetHttpRoutes = ({ config, prisma, now = () => new Date() }: FleetDeps) => {
    const app = new Hono<{ Variables: { logger: Logger } }>();

    // 401 rather than 404: unlike a sandbox's connect token, the holder here knows it is presenting a credential and
    // the useful answer is "that one does not work", which is what sends them to the Tokens page.
    const callerOf = async (c: { req: { header: (name: string) => string | undefined } }): Promise<VerifiedToken | undefined> =>
        await verifyApiToken(prisma, bearerOf(c.req.header(`authorization`)), `provision`);

    /* Whether the token still names an account. The probe behind the `fleet` capability's status row. */
    app.get(`/whoami`, async (c) => {
        const caller = await callerOf(c);
        return caller === undefined
            ? c.json({ error: `that provisioning token was revoked or never existed` }, 401)
            : c.json({ email: caller.email, label: caller.label });
    });

    /* The account's sandboxes, addressing only: what an agent needs to say what exists and what has never come up. */
    app.get(`/sandboxes`, async (c) => {
        const caller = await callerOf(c);
        if (caller === undefined) {
            return c.json({ error: `that provisioning token was revoked or never existed` }, 401);
        }
        const rows = await prisma.sandbox.findMany({
            where: { ownerId: caller.userId, removedAt: null },
            select: { id: true, name: true, daemonUrl: true, lastSeenAt: true },
            orderBy: { createdAt: `asc` },
        });
        return c.json({
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
    app.post(`/provision`, async (c) => {
        const caller = await callerOf(c);
        if (caller === undefined) {
            return c.json({ error: `that provisioning token was revoked or never existed` }, 401);
        }
        const parsed = ProvisionSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ error: `the provision body must be {"name":"…"} with an optional "definition" of TOML` }, 400);
        }
        const since = new Date(now().getTime() - PROVISION_WINDOW_MS);
        const recent = await prisma.sandbox.count({ where: { ownerId: caller.userId, createdAt: { gt: since } } });
        if (recent >= PROVISION_PER_WINDOW) {
            return c.json({ error: `this account has created ${recent} sandboxes in the last hour; provisioning is paused until that window passes` }, 429);
        }
        const { sandbox } = await mintSandbox(prisma, config, { name: parsed.data.name, ownerId: caller.userId });
        try {
            const minted = await mintSetupCodeFor(prisma, config, sandbox, { ownerEmail: caller.email, definitionSeed: parsed.data.definition });
            return c.json({ sandboxId: sandbox.id, name: sandbox.name, hostname: minted.hostname, setupCode: minted.code, expiresAt: minted.expiresAt });
        } catch (error) {
            // The row exists and cannot be claimed, which is worse than never having made it: take it back out rather
            // than leaving an unreachable name in the owner's switcher.
            await prisma.sandbox.delete({ where: { id: sandbox.id } }).catch(() => undefined);
            if (error instanceof ReachabilityUnavailable) {
                return c.json({ error: error.message }, 503);
            }
            c.get(`logger`)?.warn({ err: error, ownerId: caller.userId }, `fleet provision failed`);
            return c.json({ error: error instanceof Error ? error.message : `the sandbox could not be prepared` }, 502);
        }
    });

    return app;
};
