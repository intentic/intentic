import { oc } from "@orpc/contract";
import { BuiltinPromptSchema, BuiltinPromptTextSchema, CleanerSavingsSchema, OkSchema, SandboxSettingsSchema } from "../schemas.js";

// Per-sandbox agent settings (.intentic/settings.json). `get` returns the current flags with defaults applied
// when the file is absent; `set` overwrites them. `savings` reports the output-cleaner token savings aggregated
// from the live filter-stats ledger (the rtk-`gain` surface — read-only, so a UI card can show what's working).
// `builtinPrompt` returns one of the two built-in system prompts as text — Intentic's own, or Claude Code's
// read out of the installed CLI — so the settings page can SHOW the prompt behind a mode instead of asking the
// user to trust a description of it, and can fork either into a custom one.
export const settingsContract = {
    get: oc.route({ method: "GET", path: "/settings" }).output(SandboxSettingsSchema),
    set: oc.route({ method: "POST", path: "/settings" }).input(SandboxSettingsSchema).output(OkSchema),
    savings: oc.route({ method: "GET", path: "/settings/savings" }).output(CleanerSavingsSchema),
    builtinPrompt: oc.route({ method: "GET", path: "/settings/system-prompt/{base}" }).input(BuiltinPromptSchema).output(BuiltinPromptTextSchema),
};
