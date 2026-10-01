import type { PrismaClient } from "@intentic/prisma";
import { Hono } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import type { Config } from "../config.js";
import { DaemonVersionSchema } from "./daemon-version.js";
import { adoptSandbox, identityField, readPlatformIdentity } from "./recovery.js";

interface RecoveryDeps {
    readonly config: Config;
    readonly prisma: PrismaClient;
}

const isHttpsUrl = (value: string): boolean => URL.canParse(value) && new URL(value).protocol === `https:`;

// What a daemon sends to be adopted; the version is read on its own, since a daemon naming none (or a malformed one) is
// still adopted, only without a stored version, as an announce is.
const AdoptionBodySchema = z.object({
    ticket: z.string().min(1),
    grant: z.string().min(1),
    daemonUrl: z.string().refine(isHttpsUrl),
    owner: z.string().optional(),
    name: z.string().optional(),
    image: z.string().optional(),
    version: z.unknown().optional(),
});

/* `POST /sandbox/adopt` and `GET /api/identity`, mounted by app.ts at the root beside the other routes machines call:
 * the two doors a platform that forgot a sandbox needs (recovery.ts). */
export const recoveryHttpRoutes = ({ config, prisma }: RecoveryDeps) => {
    const app = new Hono<{ Variables: { logger: Logger } }>();

    // A sandbox the registry has no row for asks for one back, on its owner's say: an adoption ticket the owner's browser
    // got here and handed the daemon, the grant this platform signed for the token, the address the token derives and
    // the owner the daemon bound (recovery.ts has the order). Authenticated by the connect token like announce; the row
    // it makes carries that token, so the daemon's next announce lands on it.
    app.post(`/sandbox/adopt`, async (c) => {
        const token = c.req.header(`x-intentic-connect`);
        if (token === undefined || token === ``) {
            return c.text(`error: missing token`, 400);
        }
        // allow(silent-catch): a body that is not JSON is a malformed adoption, which the parse below refuses.
        const body = AdoptionBodySchema.safeParse(await c.req.json().catch(() => undefined));
        if (!body.success) {
            return c.text(`error: an adoption names its ticket, its grant and an https daemonUrl`, 400);
        }
        const version = DaemonVersionSchema.safeParse(body.data.version);
        const verdict = await adoptSandbox(
            prisma,
            config,
            {
                token,
                ticket: body.data.ticket,
                grant: body.data.grant,
                daemonUrl: body.data.daemonUrl,
                owner: body.data.owner === `` ? undefined : body.data.owner,
                name: body.data.name,
                image: body.data.image,
                version: version.success ? version.data : null,
            },
            Date.now(),
        );
        if (verdict.kind === `refused`) {
            c.get(`logger`).warn({ status: verdict.status, reason: verdict.message }, `adoption refused`);
            return c.text(`error: ${verdict.message}`, verdict.status);
        }
        c.get(`logger`).info({ sandboxId: verdict.sandboxId, kind: verdict.kind }, `sandbox adopted`);
        return c.json({ ok: true, sandboxId: verdict.sandboxId, ...(await identityField(prisma)) });
    });

    // Which database this platform is reading: unauthenticated, since an identity is no secret and the editor asks
    // before anyone is signed in. 503 when the database cannot say, never an identity made up for it.
    app.get(`/api/identity`, async (c) => {
        try {
            const held = await readPlatformIdentity(prisma);
            return c.json({ identity: held.identity, since: held.since.toISOString() });
        } catch (error) {
            c.get(`logger`).warn({ err: error }, `platform identity unreadable`);
            return c.json({ error: `the platform's database cannot say which it is` }, 503);
        }
    });

    return app;
};
