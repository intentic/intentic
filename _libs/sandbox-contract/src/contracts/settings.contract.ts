import { oc } from "@orpc/contract";
import { CleanerSavingsSchema, DefaultSystemPromptSchema, OkSchema, SandboxSettingsSchema } from "../schemas.js";

// Per-sandbox agent settings (.intentic/settings.json). `get` returns the current flags with defaults applied
// when the file is absent; `set` overwrites them. `savings` reports the output-cleaner token savings aggregated
// from the live filter-stats ledger (the rtk-`gain` surface — read-only, so a UI card can show what's working).
// `defaultPrompt` reads Claude Code's own system prompt out of the installed CLI, so the settings page can show
// the default a blank `systemPrompt` resolves to instead of asking the user to trust a description of it.
export const settingsContract = {
    get: oc.route({ method: "GET", path: "/settings" }).output(SandboxSettingsSchema),
    set: oc.route({ method: "POST", path: "/settings" }).input(SandboxSettingsSchema).output(OkSchema),
    savings: oc.route({ method: "GET", path: "/settings/savings" }).output(CleanerSavingsSchema),
    defaultPrompt: oc.route({ method: "GET", path: "/settings/default-prompt" }).output(DefaultSystemPromptSchema),
};
