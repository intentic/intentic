import { providerKeysContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { resolveProviderKey } from "./provider-keys.js";

// The provider-API-key routes (Sandbox ▸ Agent). `status` reports only presence (store OR container-env fallback),
// never the secret; `set` stores/overwrites one key; `remove` clears the stored key (the env fallback, if any,
// still applies). The bundled translator watches the store file and reloads, so a set/remove takes effect on the
// next routed turn without a daemon restart.
export const createProviderKeysRoutes = (services: Services) => {
    const i = implement(providerKeysContract).$context<OrpcContext>();
    return {
        status: i.status.handler(async () => ({
            codex: (await resolveProviderKey(services.providerKeys, services.config, "codex")) !== undefined,
            grok: (await resolveProviderKey(services.providerKeys, services.config, "grok")) !== undefined,
        })),
        set: i.set.handler(async ({ input }) => {
            await services.providerKeys.set(input.provider, input.key);
            return { ok: true } as const;
        }),
        remove: i.remove.handler(async ({ input }) => {
            await services.providerKeys.remove(input.provider);
            return { ok: true } as const;
        }),
    };
};
