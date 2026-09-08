import { settingsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { INTENTIC_PROMPT } from "../agent/prompt/intentic-prompt.js";
import { presetSystemPrompt } from "../agent/prompt/preset-prompt.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { readInputSavings } from "../logs/filter-stats.js";
import { ManifestUnreadableError } from "../store/json-file.js";
import { readTierReport } from "../usage/tier-report.js";
import { readTurnExperiments } from "../usage/turn-experiments.js";
import { reconcileBakedSkills } from "./skills.js";

// `get` applies defaults when the manifest is absent, `set` overwrites it. `savings` reads whichever backend's ledger
// is currently compressing: the setting picking the cleaner also picks the ledger read here.
export const createSettingsRoutes = (services: Services) => {
    const i = implement(settingsContract).$context<OrpcContext>();
    return {
        get: i.get.handler(() => services.sandboxSettings.get()),
        set: i.set.handler(async ({ input }) => {
            await services.sandboxSettings.set(input).catch((error: unknown) => {
                // The owner's file to fix, not a server fault: the message names it and what this build could not read.
                if (error instanceof ManifestUnreadableError) {
                    throw new ORPCError("CONFLICT", { message: error.message });
                }
                throw error;
            });
            // Converges the baked tools with the new list for the next turn; a failed write only warns, the save still
            // succeeds.
            await reconcileBakedSkills(services, input.skills).catch((error: unknown) => services.logger.warn({ err: error }, "skill reconcile failed"));
            return { ok: true } as const;
        }),
        savings: i.savings.handler(async ({ input }) => {
            const [inputSavings, experiments, tier] = await Promise.all([
                readInputSavings(services.config.historyRoot, input),
                readTurnExperiments(services.usage, input),
                readTierReport(services.usage, input),
            ]);
            return { input: inputSavings, ...experiments, ...(tier !== undefined ? { tier } : {}) };
        }),
        // Intentic's prompt is shipped text: instant, no version of its own. Claude's is read from the installed CLI;
        // the workspace root only says where to spawn that probe, nothing is read from it.
        builtinPrompt: i.builtinPrompt.handler(({ input }) =>
            input.base === "intentic" ? { text: INTENTIC_PROMPT, version: "" } : presetSystemPrompt(services.workspace.root),
        ),
        // When each rule last fired, so the settings list can show a rule that's gone quiet as quiet rather than merely
        // present.
        firings: i.firings.handler(() => services.ruleFirings.get()),
    };
};
