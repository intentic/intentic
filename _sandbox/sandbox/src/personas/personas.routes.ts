import { personasContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { hasSession } from "../browser/session-store.js";

// The sandbox's named personas. No apply step and no teardown: saving a card connects nothing and removing one
// disconnects nothing (personas.contract.ts says why at length) — the accounts themselves are capabilities and
// keep their own lifecycle.
export const createPersonasRoutes = (services: Services) => {
    const i = implement(personasContract).$context<OrpcContext>();
    return {
        list: i.list.handler(async () => {
            const [personas, capabilities] = await Promise.all([services.personas.list(), services.capabilities.list()]);
            /* Which of the accounts these cards name can actually act right now. `hasSession` rather than mere
             * presence in the manifest: a browser capability exists from the moment it is added, and is only
             * usable once the owner has finished its guided login — which is exactly the state a cloned
             * workspace's whole roster sits in, so conflating the two would show every persona as ready on the one
             * occasion none of them are. */
            const connected = capabilities
                .filter((capability) => capability.kind === "browser" && hasSession(services.workspace.root, capability.id))
                .map((capability) => capability.id);
            return { personas, connected };
        }),
        save: i.save.handler(async ({ input }) => {
            await services.personas.upsert(input);
            return { ok: true as const };
        }),
        remove: i.remove.handler(async ({ input }) => {
            await services.personas.remove(input.id);
            return { ok: true as const };
        }),
    };
};
