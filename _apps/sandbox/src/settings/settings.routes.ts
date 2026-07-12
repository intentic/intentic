import { settingsContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { reconcileLspSkill } from "./lsp-skill.js";

// The per-sandbox agent-settings routes. `get` applies defaults when the manifest is absent; `set` overwrites it.
export const createSettingsRoutes = (services: Services) => {
    const i = implement(settingsContract).$context<OrpcContext>();
    return {
        get: i.get.handler(() => services.sandboxSettings.get()),
        set: i.set.handler(async ({ input }) => {
            await services.sandboxSettings.set(input);
            // Converge the lsp skill with the new lspTools value so the next turn sees it (a failed write only
            // warns — the flag is still saved, the skill just lags until the next save/boot).
            await reconcileLspSkill(services, input.lspTools).catch((error: unknown) =>
                services.logger.warn({ err: error }, "lsp skill reconcile failed"),
            );
            return { ok: true } as const;
        }),
    };
};
