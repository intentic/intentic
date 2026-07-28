import { settingsContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import { presetSystemPrompt } from "../agent/preset-prompt.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { readCleanerSavings } from "../logs/filter-stats.js";
import { reconcileSkills } from "./skills.js";

// The per-sandbox agent-settings routes. `get` applies defaults when the manifest is absent; `set` overwrites it;
// `savings` reports the output-cleaner token savings from the ledger of whichever backend is currently doing the
// compressing — so the setting that decides which cleaner runs also decides which ledger is read;
// `defaultPrompt` reads Claude Code's own system prompt out of the installed CLI (preset-prompt.ts).
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
        savings: i.savings.handler(async () => readCleanerSavings(services.config.historyRoot, (await services.sandboxSettings.get()).filterBackend)),
        // The workspace root is only where the probe's CLI is spawned — it reads nothing from it (no tools, no
        // setting sources). It has to be a directory that exists, which is the whole requirement.
        defaultPrompt: i.defaultPrompt.handler(() => presetSystemPrompt(services.workspace.root)),
    };
};
