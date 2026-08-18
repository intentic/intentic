import { settingsContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import { INTENTIC_PROMPT } from "../agent/intentic-prompt.js";
import { presetSystemPrompt } from "../agent/preset-prompt.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { readInputSavings } from "../logs/filter-stats.js";
import { readTurnExperiments } from "../usage/turn-experiments.js";
import { reconcileSkills } from "./skills.js";

// The per-sandbox agent-settings routes. `get` applies defaults when the manifest is absent; `set` overwrites it;
// `savings` reports what each token-reduction mechanism was worth over the requested window — the cleaners from
// the ledger of whichever backend is currently doing the compressing (so the setting that decides which cleaner
// runs also decides which ledger is read), the terse steer and the iq search teaching from the spend ledger's
// experiment arms; `defaultPrompt` reads Claude Code's own system prompt out of the installed CLI
// (preset-prompt.ts).
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
        savings: i.savings.handler(async ({ input }) => {
            const [inputSavings, experiments] = await Promise.all([
                readInputSavings(services.config.historyRoot, input),
                readTurnExperiments(services.usage, input),
            ]);
            return { input: inputSavings, ...experiments };
        }),
        // Intentic's prompt is text this app ships, so it answers instantly and has no version of its own to
        // report. Claude's has to be read out of the installed CLI: the workspace root is only where that probe
        // is spawned — it reads nothing from it (no tools, no setting sources), it just has to exist.
        builtinPrompt: i.builtinPrompt.handler(({ input }) =>
            input.base === "intentic" ? { text: INTENTIC_PROMPT, version: "" } : presetSystemPrompt(services.workspace.root),
        ),
        // When each rule last did something — what the settings list shows beside a rule so one that has been
        // silent for three weeks is visible as such rather than merely present.
        firings: i.firings.handler(() => services.ruleFirings.get()),
    };
};
