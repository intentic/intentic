import { keysContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";

export type KeysRoutesDeps = Pick<Services, "keyed">;

/* CONNECTING A PROVIDER YOU ALREADY HOLD A KEY FOR (Sandbox ▸ Agent). Four handlers over every keyed provider,
 * because the provider is a route parameter (keys.contract.ts says why) and the four operations are the same
 * ones for all of them: list what is connected, store a pasted key, rename one, remove one.
 *
 * THE CATALOG IS FORGOTTEN ON EVERY WRITE, and that is the only non-obvious line in this file. The catalog is
 * read with the FIRST stored key and cached for a minute; connecting, renaming or disconnecting changes which
 * key that is, or whether there is one at all. Without the forget, a sandbox that just disconnected its only
 * Z.ai key would keep offering that key's model list — and, worse, a turn resolved against it — for the rest of
 * the TTL. The same reasoning the endpoint catalog's `forget` already carries for a capability edit. */
export const createKeysRoutes = (services: KeysRoutesDeps) => {
    const i = implement(keysContract).$context<OrpcContext>();
    return {
        accounts: i.accounts.handler(async ({ input }) => ({ accounts: await services.keyed[input.provider].store.list() })),
        connect: i.connect.handler(async ({ input }) => {
            const slice = services.keyed[input.provider];
            const account = await slice.store.connect({
                apiKey: input.apiKey,
                ...(input.label !== undefined ? { label: input.label } : {}),
            });
            slice.catalog.forget();
            return account;
        }),
        rename: i.rename.handler(async ({ input }) => {
            const renamed = await services.keyed[input.provider].store.rename(input.id, input.label);
            // A rename that matched nothing is the caller addressing an account that is gone, which is a 404
            // rather than a silent success: the row they are looking at no longer exists and the page should
            // say so instead of appearing to have applied the change.
            if (renamed === undefined) {
                throw new ORPCError("NOT_FOUND", { message: `No ${input.provider} account with that id is connected.` });
            }
            return { ok: true } as const;
        }),
        disconnect: i.disconnect.handler(async ({ input }) => {
            const slice = services.keyed[input.provider];
            await slice.store.disconnect(input.id);
            slice.catalog.forget();
            return { ok: true } as const;
        }),
    };
};
