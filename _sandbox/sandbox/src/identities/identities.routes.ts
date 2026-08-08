import { identitiesContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { hasSession } from "../browser/session-store.js";

// The cast of named faces. No apply step and no teardown: saving a card connects nothing and removing one
// disconnects nothing (identities.contract.ts says why at length) — the accounts themselves are capabilities and
// keep their own lifecycle.
export const createIdentitiesRoutes = (services: Services) => {
    const i = implement(identitiesContract).$context<OrpcContext>();
    return {
        list: i.list.handler(async () => {
            const [identities, capabilities] = await Promise.all([services.identities.list(), services.capabilities.list()]);
            /* Which of the accounts these cards name can actually act right now. `hasSession` rather than mere
             * presence in the manifest: a browser capability exists from the moment it is added, and is only
             * usable once the owner has finished its guided login — which is exactly the state a cloned
             * workspace's whole cast sits in, so conflating the two would show every face as ready on the one
             * occasion none of them are. */
            const connected = capabilities
                .filter((capability) => capability.kind === "browser" && hasSession(services.workspace.root, capability.id))
                .map((capability) => capability.id);
            return { identities, connected };
        }),
        save: i.save.handler(async ({ input }) => {
            await services.identities.upsert(input);
            return { ok: true as const };
        }),
        remove: i.remove.handler(async ({ input }) => {
            await services.identities.remove(input.id);
            return { ok: true as const };
        }),
    };
};
