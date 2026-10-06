import type { PrismaClient } from "@intentic/prisma";
import { Hono } from "hono";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import { ingressServer } from "../ingress.js";
import { DaemonVersionSchema } from "./daemon-version.js";
import { adoptSandbox, identityField, readPlatformIdentity } from "./recovery.js";

interface RecoveryDeps {
    readonly config: Config;
    readonly prisma: PrismaClient;
}

/* `POST /sandbox/adopt` and `GET /api/identity`, mounted by app.ts at the root beside the other routes machines call:
 * the two doors a platform that forgot a sandbox needs (recovery.ts). */
export const recoveryHttpRoutes = ({ config, prisma }: RecoveryDeps) => {
    const app = new Hono<{ Variables: { logger: Logger } }>();
    const ingress = ingressServer(app);

    // A sandbox the registry has no row for asks for one back, on its owner's say: an adoption ticket the owner's browser
    // got here and handed the daemon, the grant this platform signed for the token, the address the token derives and
    // the owner the daemon bound (recovery.ts has the order). Authenticated by the connect token like announce; the row
    // it makes carries that token, so the daemon's next announce lands on it.
    // The version is read on its own, since a daemon naming none (or a malformed one) is still adopted, only without a
    // stored version, as an announce is.
    ingress(`adopt`, async (c, kit) => {
        const token = kit.connectToken;
        if (token === undefined) {
            return kit.refuse(400, `missing token`);
        }
        const body = await kit.body();
        if (body === undefined) {
            return kit.refuse(400, `an adoption names its ticket, its grant and an https daemonUrl`);
        }
        const version = DaemonVersionSchema.safeParse(body.version);
        const verdict = await adoptSandbox(
            prisma,
            config,
            {
                token,
                ticket: body.ticket,
                grant: body.grant,
                daemonUrl: body.daemonUrl,
                owner: body.owner === `` ? undefined : body.owner,
                name: body.name,
                image: body.image,
                version: version.success ? version.data : null,
            },
            Date.now(),
        );
        if (verdict.kind === `refused`) {
            c.get(`logger`).warn({ status: verdict.status, reason: verdict.message }, `adoption refused`);
            return kit.refuse(verdict.status, verdict.message);
        }
        c.get(`logger`).info({ sandboxId: verdict.sandboxId, kind: verdict.kind }, `sandbox adopted`);
        return kit.answer({ ok: true, sandboxId: verdict.sandboxId, ...(await identityField(prisma)) });
    });

    // Which database this platform is reading: unauthenticated, since an identity is no secret and the editor asks
    // before anyone is signed in. 503 when the database cannot say, never an identity made up for it.
    ingress(`identity`, async (c, kit) => {
        try {
            const held = await readPlatformIdentity(prisma);
            return kit.answer({ identity: held.identity, since: held.since.toISOString() });
        } catch (error) {
            c.get(`logger`).warn({ err: error }, `platform identity unreadable`);
            return kit.refuse(503, `the platform's database cannot say which it is`);
        }
    });

    return app;
};
