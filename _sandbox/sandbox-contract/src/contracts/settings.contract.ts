import { oc } from "@orpc/contract";
import {
    BuiltinPromptSchema,
    BuiltinPromptTextSchema,
    DayWindowQuerySchema,
    OkSchema,
    RuleFiringsSchema,
    SandboxSettingsSchema,
    SavingsReportSchema,
} from "../schemas.js";

// Per-sandbox agent settings (.intentic/config/settings.json). `get` returns the current flags with defaults applied
// when the file is absent; `set` overwrites them. `savings` reports what each token-reduction mechanism was
// worth, the cleaners' realized per-command savings and the terse steer's measured A/B, over an inclusive
// UTC day window, the same one the spend ledger takes, so a screen can filter both with one calendar.
// `builtinPrompt` returns one of the two built-in system prompts as text. Intentic's own, or Claude Code's
// read out of the installed CLI, so the settings page can SHOW the prompt behind a mode instead of asking the
// user to trust a description of it, and can fork either into a custom one.
export const settingsContract = {
    get: oc.route({ method: "GET", path: "/settings" }).output(SandboxSettingsSchema),
    set: oc.route({ method: "POST", path: "/settings" }).input(SandboxSettingsSchema).output(OkSchema),
    savings: oc.route({ method: "GET", path: "/settings/savings" }).input(DayWindowQuerySchema).output(SavingsReportSchema),
    builtinPrompt: oc.route({ method: "GET", path: "/settings/system-prompt/{base}" }).input(BuiltinPromptSchema).output(BuiltinPromptTextSchema),
    // When each rule last did something, keyed by rule id. Its own route rather than a field on the settings
    // object because a firing is not an edit: folding it in would make every push a settings write, and would
    // put a value that changes on its own inside the object the screen optimistically patches.
    firings: oc.route({ method: "GET", path: "/settings/rule-firings" }).output(RuleFiringsSchema),
};
