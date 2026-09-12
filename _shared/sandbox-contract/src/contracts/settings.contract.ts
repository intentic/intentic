import { oc } from "@orpc/contract";
import {
    BuiltinPromptSchema,
    BuiltinPromptTextSchema,
    REPO_CHECKS_FILE,
    RepoChecksAdoptSchema,
    RepoChecksListSchema,
    RuleFiringsSchema,
    SandboxSettingsSchema,
    SavingsReportSchema,
} from "../schemas/settings.js";
import { OkSchema } from "../schemas/shared.js";
import { DayWindowQuerySchema } from "../schemas/usage.js";

// Per-sandbox agent settings (.intentic/config/settings.json); `get` fills defaults for an absent file, `set`
// overwrites whole. `savings` measures each token-reduction mechanism's worth over the same UTC day window the spend
// ledger takes. `builtinPrompt` returns a built-in prompt's actual text to show or fork.
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
    // Own route, not a settings field: a firing isn't an edit, so it shouldn't cost a settings write.
    firings: oc
        .route({
            method: "GET",
            path: "/settings/rule-firings",
            summary: "When each rule last did something",
            description:
                "A separate read rather than a field on the settings, because a rule firing is not somebody editing anything: folding it in would turn every firing into a settings write and put a self-changing value inside the object a screen edits.",
        })
        .output(RuleFiringsSchema),
    // Read off the repositories themselves, not out of the settings file: the declaration is a tracked file in each
    // repository, and only the owner's answer to it lives here.
    repoChecks: oc
        .route({
            method: "GET",
            path: "/settings/repo-checks",
            summary: "What each repository asks to run on its own code",
            description: `Every repository that declares its own checks at \`${REPO_CHECKS_FILE}\`, what it declares, and whether you have switched it on. A repository declares what to run because the command belongs beside the scripts it names; nothing it declares runs until you say so.`,
        })
        .output(RepoChecksListSchema),
    adoptRepoChecks: oc
        .route({
            method: "POST",
            path: "/settings/repo-checks/adopt",
            summary: "Switch a repository's own checks on or off",
            description:
                "Adopts exactly what that repository declares as it stands now. If the declaration changes afterwards it stops running until you adopt it again, so a command nobody has read cannot inherit the answer given to a different one.",
        })
        .input(RepoChecksAdoptSchema)
        .output(OkSchema),
};
