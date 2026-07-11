import { settingsContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";

// The per-sandbox agent-settings routes. `get` applies defaults when the manifest is absent; `set` overwrites it.
export const createSettingsRoutes = (services: Services) => {
    const i = implement(settingsContract).$context<OrpcContext>();
    return {
        get: i.get.handler(() => services.sandboxSettings.get()),
        set: i.set.handler(async ({ input }) => {
            await services.sandboxSettings.set(input);
            return { ok: true } as const;
        }),
    };
};
