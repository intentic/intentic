import { settingsContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { readCleanerSavings } from "../logs/filter-stats.js";
import { reconcileSkills } from "./skills.js";

// The per-sandbox agent-settings routes. `get` applies defaults when the manifest is absent; `set` overwrites it;
// `savings` reports the output-cleaner token savings from the live filter-stats ledger (the rtk-`gain` surface).
export const createSettingsRoutes = (services: Services) => {
    const i = implement(settingsContract).$context<OrpcContext>();
    return {
        get: i.get.handler(() => services.sandboxSettings.get()),
        set: i.set.handler(async ({ input }) => {
            await services.sandboxSettings.set(input);
            // Converge the baked-tool skills with the new `skills` list so the next turn sees them (a failed write
            // only warns — the setting is still saved, the skill files just lag until the next save/boot).
            await reconcileSkills(services, input.skills).catch((error: unknown) => services.logger.warn({ err: error }, "skill reconcile failed"));
            return { ok: true } as const;
        }),
        savings: i.savings.handler(() => readCleanerSavings(services.config.historyRoot)),
    };
};
