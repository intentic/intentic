import type { PrismaClient } from "@intentic/prisma";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { Hono } from "hono";
import type { Logger } from "pino";
import { ingressServer } from "../ingress.js";
import { orgPolicyForToken } from "./org-policy.js";

/* `POST /sandbox/org-policy`, mounted by app.ts at the root beside the other routes machines call: a sandbox's daemon
 * asking which organisation policy it is held to, over its connect token, the same door as announce. A personal sandbox
 * is answered `{ policy: null }`, which is also how one an admin unbound learns it. */
export const orgPolicyHttpRoutes = ({ prisma }: { readonly prisma: PrismaClient }) => {
    const app = new Hono<{ Variables: { logger: Logger } }>();
    const ingress = ingressServer(app);
    ingress(`orgPolicy`, async (_c, kit) => {
        const token = kit.connectToken;
        if (token === undefined) {
            return kit.refuse(400, `missing token`);
        }
        const answer = await orgPolicyForToken(prisma, sha256Hex(token), (await kit.body())?.applied);
        return answer === undefined ? kit.refuse(404, `unknown sandbox`) : kit.answer(answer);
    });
    return app;
};
