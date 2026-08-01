import { expect, test } from "vitest";
import { CapabilitiesListSchema, SandboxSettingsSchema } from "./schemas.js";

/* The settings shape spans a version seam that really moves: the browser ships with the platform, the daemon
 * ships inside the user's sandbox image, so a web build routinely parses a payload from an OLDER daemon. These
 * tests pin the property that makes that survivable — an absent key is that flag's default, not a parse
 * failure — because failing instead reaches the user as a settings page whose switches silently do nothing. */

test("a payload from a build that predates a toggle parses, with the new toggle at its default", () => {
    // What a daemon built before the output-cleaner backend switch answers with: every key it knew, and
    // nothing for the one added after it shipped.
    const older = {
        stableSystemPrompt: false,
        skills: [],
        hashlineEdits: false,
        terseOutput: true,
        iqSearch: true,
        outputCleaners: "-cap",
        outputHoldout: 0.1,
    };
    expect(SandboxSettingsSchema.parse(older)).toEqual({
        ...older,
        terseHoldout: 0,
        iqContext: false,
        iqContextHoldout: 0,
        filterBackend: "native",
        systemPromptMode: "intentic",
        systemPrompt: "",
        quickModel: "",
        agentRetentionDays: 3,
        autoLand: true,
        resumeAfterOutage: true,
        autoResumeOnRestart: true,
        prepushCommand: "",
        prepushTimeoutMs: 900_000,
        prepushFixModel: "",
        prepushFixEffort: "",
    });
});

test("an empty object is the full default settings object", () => {
    expect(SandboxSettingsSchema.parse({})).toEqual({
        stableSystemPrompt: false,
        skills: [],
        hashlineEdits: false,
        terseOutput: false,
        // Off: the steer's turn-level control spends the tokens it measures, so measuring is opt-in.
        terseHoldout: 0,
        iqSearch: false,
        // Off, and its holdout with it: pre-injection spends input tokens on every eligible turn, and the
        // control that would tell you whether they paid for themselves costs the turns it measures.
        iqContext: false,
        iqContextHoldout: 0,
        outputCleaners: "off",
        outputHoldout: 0,
        filterBackend: "native",
        // The default base is Intentic's own prompt; the text field is only read under "custom".
        systemPromptMode: "intentic",
        systemPrompt: "",
        // Empty is not "no quick model" — it is Auto, resolved from the connected accounts on every read
        // (quick-model.ts). Storing a resolved id as the default would name a provider a fresh sandbox has no
        // credential for, and would go stale the moment one is connected.
        quickModel: "",
        // The one default that isn't "off": the fleet board's Finished lane has no exit of its own, and each
        // card it holds is a worktree checkout. Opting INTO cleanup would mean shipping a leak by default.
        agentRetentionDays: 3,
        // On because it is the historical behaviour — defaulting off would silently hold every existing
        // sandbox's finished work on branches nobody is watching.
        autoLand: true,
        // On, where a spent usage limit re-runs nothing: an outage resume spends nothing the dead turn hadn't
        // already committed, and the turns it saves are the unattended ones nobody is watching to restart by hand.
        resumeAfterOutage: true,
        // On: a daemon restart is usually intentic's own doing (an image update, an approved environment
        // change), not the user's decision, so the turn it interrupted resumes rather than staying stuck.
        autoResumeOnRestart: true,
        // Empty disables the pre-push check until the owner supplies this workspace's verification command.
        prepushCommand: "",
        prepushTimeoutMs: 900_000,
        // Empty ⇒ the suggested fix session opens on whatever the chat composer would have started with, which
        // is the model the user already chose to work with.
        prepushFixModel: "",
        prepushFixEffort: "",
    });
});

test("a key of the wrong type is still a parse failure — tolerance is for absence, not for garbage", () => {
    expect(SandboxSettingsSchema.safeParse({ iqSearch: "yes" }).success).toBe(false);
    expect(SandboxSettingsSchema.safeParse({ outputHoldout: 4 }).success).toBe(false);
    // The prompt cap is a real bound, not advice: the text IS the system prompt, and every turn pays for it.
    expect(SandboxSettingsSchema.safeParse({ systemPrompt: "x".repeat(20001) }).success).toBe(false);
});

/* The capability list crosses the same seam, and its failure mode is worse than a dead switch: the browser
 * parses ONE object for the whole page, so a required key the older daemon never sends takes the Capabilities
 * page down entirely — to hide an advisory badge. */

test("a capability list from a daemon that predates recommendations parses, with none recommended", () => {
    const older = { capabilities: [{ id: "github", kind: "cli", status: { state: "active" }, config: { provider: "github" } }] };
    expect(CapabilitiesListSchema.parse(older).recommendations).toEqual([]);
});
