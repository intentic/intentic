import { RelinkRequestSchema } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import type { AppEnv } from "../../app-env.js";
import { ownershipDenied } from "../../auth/owner-gates.js";
import type { Services } from "../../composition.js";

// POST /platform/relink, the owner's Reconnect (announce.ts). Gated by ownership rather than the operating gate, as
// membership is: an adoption has the platform list this sandbox under the account asking, which only its owner decides.
export const createRelinkRoute =
    (services: Pick<Services, "auth" | "announcer" | "ownerEmail">) =>
    async (c: Context<AppEnv>): Promise<Response> => {
        const denied = await ownershipDenied(services, c);
        if (denied !== undefined) {
            return denied;
        }
        // allow(silent-catch): an empty body is a plain re-registration, which the parse below reads as one.
        const body = RelinkRequestSchema.safeParse(await c.req.json().catch(() => ({})));
        if (!body.success) {
            return c.json({ error: "a relink names at most an adoption ticket, a name and an image" }, 400);
        }
        const { ticket, name, image } = body.data;
        if (ticket === undefined) {
            return c.json(await services.announcer.relink());
        }
        const owner = await services.ownerEmail();
        if (owner === undefined) {
            return c.json({ error: "this sandbox has no owner yet: set it up instead" }, 409);
        }
        return c.json(await services.announcer.relink({ ticket, owner, name, image }));
    };
