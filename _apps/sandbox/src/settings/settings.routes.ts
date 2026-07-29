import { settingsContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import { INTENTIC_PROMPT } from "../agent/intentic-prompt.js";
import { presetSystemPrompt } from "../agent/preset-prompt.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { readInputSavings } from "../logs/filter-stats.js";
import { readOutputSavings } from "../usage/terse-savings.js";
import { reconcileSkills } from "./skills.js";

// The per-sandbox agent-settings routes. `get` applies defaults when the manifest is absent; `set` overwrites it;
// `savings` reports what each token-reduction mechanism was worth over the requested window — the cleaners from
// the ledger of whichever backend is currently doing the compressing (so the setting that decides which cleaner
// runs also decides which ledger is read), the terse steer from the spend ledger's two experiment arms;
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
        savings: i.savings.handler(async ({ input }) => {
            const { filterBackend } = await services.sandboxSettings.get();
            const [inputSavings, outputSavings] = await Promise.all([
                readInputSavings(services.config.historyRoot, filterBackend, input),
                readOutputSavings(services.usage, input),
            ]);
            return { input: inputSavings, ...(outputSavings !== undefined ? { output: outputSavings } : {}) };
        }),
        // Intentic's prompt is text this app ships, so it answers instantly and has no version of its own to
        // report. Claude's has to be read out of the installed CLI: the workspace root is only where that probe
        // is spawned — it reads nothing from it (no tools, no setting sources), it just has to exist.
        builtinPrompt: i.builtinPrompt.handler(({ input }) =>
            input.base === "intentic" ? { text: INTENTIC_PROMPT, version: "" } : presetSystemPrompt(services.workspace.root),
        ),
    };
};
