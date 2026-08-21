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
    get: oc
        .route({
            method: "GET",
            path: "/settings",
            summary: "How this sandbox is configured",
            description: "Every setting that governs how agents behave here, with the defaults filled in for anything nobody has chosen.",
        })
        .output(SandboxSettingsSchema),
    set: oc
        .route({
            method: "POST",
            path: "/settings",
            summary: "Change the sandbox settings",
            description: "Writes the settings whole, so send the complete object rather than the fields you changed.",
        })
        .input(SandboxSettingsSchema)
        .output(OkSchema),
    savings: oc
        .route({
            method: "GET",
            path: "/settings/savings",
            summary: "What the token-saving measures were worth",
            description:
                "Measured rather than estimated: what each mechanism actually saved over a range of days. The same day range the spending ledger takes, so one calendar filters both.",
        })
        .input(DayWindowQuerySchema)
        .output(SavingsReportSchema),
    builtinPrompt: oc
        .route({
            method: "GET",
            path: "/settings/system-prompt/{base}",
            summary: "Read a built-in system prompt",
            description:
                "The actual text behind one of the built-in modes, so a settings screen can show the prompt instead of asking anyone to trust a description of it, and so either can be forked into a custom one.",
        })
        .input(BuiltinPromptSchema)
        .output(BuiltinPromptTextSchema),
    // When each rule last did something, keyed by rule id. Its own route rather than a field on the settings
    // object because a firing is not an edit: folding it in would make every push a settings write, and would
    // put a value that changes on its own inside the object the screen optimistically patches.
    firings: oc
        .route({
            method: "GET",
            path: "/settings/rule-firings",
            summary: "When each rule last did something",
            description:
                "A separate read rather than a field on the settings, because a rule firing is not somebody editing anything: folding it in would turn every firing into a settings write and put a self-changing value inside the object a screen edits.",
        })
        .output(RuleFiringsSchema),
};
