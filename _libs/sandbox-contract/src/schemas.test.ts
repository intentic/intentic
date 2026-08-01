import { expect, test } from "vitest";
import { CapabilitiesListSchema, DeployOverviewResponseSchema, SandboxSettingsSchema } from "./schemas.js";

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

/* The deployments board crosses the same seam and learned it the hard way. `repos` (workspace repo → Komodo
 * stack links) shipped REQUIRED, and the first sandbox whose daemon predated it rendered
 * `Invalid input: expected array, received undefined at repos` instead of the board — a dead page, on the one
 * surface whose job is to say whether production is up, to hide a band of suggestions.
 *
 * `viewer` is the deliberate contrast: also added later, also absent from an older daemon, but OPTIONAL rather
 * than defaulted, because its absence is information. The empty state tells "the key can see nothing" apart
 * from "we could not tell", and defaulting it would have collapsed the two. */

test("an overview from a daemon that predates repo links parses, with no links rather than no board", () => {
    const older = { komodoUrl: "https://komodo.example.com", reachable: true, resources: [], servers: [], alerts: [] };
    const parsed = DeployOverviewResponseSchema.parse(older);
    expect(parsed.repos).toEqual([]);
    // Absent, NOT defaulted: the empty state reads this to avoid claiming an empty Komodo it cannot vouch for.
    expect(parsed.viewer).toBeUndefined();
});

test("a board that did carry links keeps them, and garbage in them is still a failure", () => {
    const current = {
        komodoUrl: "https://komodo.example.com",
        reachable: true,
        viewer: { username: "intentic", admin: false },
        repos: [{ repo: "app", projectName: "app", composePath: "app/compose.yaml", suggestions: ["app-prod"] }],
        resources: [],
        servers: [],
        alerts: [],
    };
    expect(DeployOverviewResponseSchema.parse(current).repos[0]?.suggestions).toEqual(["app-prod"]);
    // Tolerance is for absence, not for the wrong shape — a `repos` that is present and wrong is real drift.
    expect(DeployOverviewResponseSchema.safeParse({ ...current, repos: "none" }).success).toBe(false);
});
