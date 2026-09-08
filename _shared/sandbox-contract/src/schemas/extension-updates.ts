// Extensions: installed extension-kind capabilities resolved to their manifests; extension updates: what the registry
// check found and what the owner decided to do about it.
import { z } from "zod";
import { ExtensionManifestSchema } from "@intentic/extension-manifest";
// Each extension is addressed by its capability entry id (git-installed) or its manifest's `publisher.name`
// (image-baked, no entry), hence the dot allowed here. A rotted checkout is skipped; its capability row still shows
// status.
const extensionId = z
    .string()
    .min(1)
    .max(121)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
// Owner's per-extension update posture.
// updates: notify (default, badge and wait), agent (also prepares an agent diff-read), auto (apply unattended if
// verified and powers didn't grow, health-watched with auto-revert; otherwise falls back to notify).
// advisories: auto-disable (default, since disabling runs no new code) or notify.
export const ExtensionUpdatePolicySchema = z.object({
    updates: z.enum(["notify", "agent", "auto"]),
    advisories: z.enum(["auto-disable", "notify"]),
});
export type ExtensionUpdatePolicy = z.infer<typeof ExtensionUpdatePolicySchema>;
// A newer sha the registry lists, the update-available badge's substance. `url`/`path` ride along because updating
// follows this row as it stands now, not the original install.
export const ExtensionUpdateSchema = z.object({
    ref: z.string().describe("The commit being offered."),
    version: z.string().optional().describe("What it calls itself."),
    url: z.string().describe("Where it comes from."),
    path: z.string().optional().describe("Where inside that repository it lives."),
    trust: z.enum(["verified", "listed"]).describe("Whether anybody vouched for it, or it is merely listed."),
    // The badge renders loud (urgent) when this is set.
    securityFix: z
        .boolean()
        .optional()
        .describe("This release fixes a security problem in earlier ones, so here the old version is the dangerous one."),
    registry: z.string().describe("Which registry said so."),
    at: z.string().describe("When it was published."),
    // The card leads with this, so the owner knows why the decision is theirs.
    needsReview: z
        .string()
        .optional()
        .describe(
            "Why this one was not taken automatically and is asking for a person instead: it wants more than it used to, or nobody has vouched for it.",
        ),
    review: z
        .object({
            conversationId: z.string().describe("Where to read what it found."),
            at: z.string().describe("When it looked."),
        })
        .optional()
        .describe(
            "An agent has already read the difference between what is installed and this, so the card can link to what it found rather than offer to start looking.",
        ),
});
export type ExtensionUpdate = z.infer<typeof ExtensionUpdateSchema>;
// This installed extension was delisted; the record is for someone still running it.
export const ExtensionAdvisorySchema = z.object({
    reason: z
        .string()
        .describe(
            "Why the registry pulled the listing, in its own words. Delisting protects people browsing; this record is for the person already running it.",
        ),
    registry: z.string().describe("Which registry said so."),
    at: z.string().describe("When."),
    autoDisabled: z.boolean().describe("Whether the sandbox has already switched it off."),
});
export type ExtensionAdvisory = z.infer<typeof ExtensionAdvisorySchema>;
// Checks that the new version's declared autoStart processes and backend actually came up.
export const ExtensionHealthSchema = z.object({
    state: z
        .enum(["watching", "healthy", "unhealthy"])
        .describe("How it has behaved since the last update. Checks catch broken, not wrong, so for a while after a swap it is simply watched."),
    detail: z.string().optional().describe("What is going wrong, when something is."),
    fromRef: z.string().optional().describe("Which version it was updated from, which is what going back would return to."),
    at: z.string().describe("When the watching started."),
    autoReverted: z
        .boolean()
        .optional()
        .describe("The update was already rolled back without anybody asking. The record stays rather than pretending the attempt never happened."),
});
export type ExtensionHealth = z.infer<typeof ExtensionHealthSchema>;
// Mechanical comparison of two manifests' declared reach (`diffPowers`), as plain sentences the update dialog can
// render directly.
export const PowersDiffSchema = z.object({
    added: z.array(z.string()).describe("What the new version asks for that the running one does not. The whole point of the comparison."),
    removed: z.array(z.string()).describe("What it no longer asks for."),
    unchanged: z.array(z.string()).describe("What stays the same."),
});
export type PowersDiff = z.infer<typeof PowersDiffSchema>;
// What an owner reads before clicking Update: the offered version's story, the engines verdict, and its powers diff
// against what is installed.
export const ExtensionUpdateActionSchema = z.object({
    id: extensionId.describe("Which extension."),
    ref: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .optional()
        .describe("Which commit, in full. Leave it out for whatever the last check found, which is what most callers mean."),
});
export const ExtensionUpdatePreviewSchema = z.object({
    ref: z.string().describe("The commit this would install."),
    version: z.string().describe("What that version calls itself."),
    installedVersion: z.string().describe("What is running now."),
    engines: z.string().describe("Which sandbox versions the new one says it needs."),
    compatible: z.boolean().describe("Whether this sandbox is one of them."),
    powers: PowersDiffSchema.describe(
        "Exactly what the new code asks for that the running one does not. This is what approving an update is approving.",
    ),
});
// Environment fragment change that alters the composed overlay; the update is not wholly landed until rebuilt.
export const ExtensionUpdateAppliedSchema = z.object({
    ok: z.literal(true).describe("It went through."),
    ref: z.string().describe("Which commit is now running."),
    rebuildNeeded: z
        .boolean()
        .optional()
        .describe(
            "The new version changes what the sandbox image contains, so a one-time rebuild is still pending and the update is not wholly landed yet.",
        ),
});
export const ExtensionUpdatePolicyInputSchema = z.object({
    id: extensionId.describe("Which extension."),
    updates: z
        .enum(["notify", "agent", "auto"])
        .optional()
        .describe("What to do about a newer version: tell you, have an agent read the difference first, or just take it."),
    advisories: z.enum(["auto-disable", "notify"]).optional().describe("What to do about a security warning: switch it off at once, or tell you."),
});
export const ExtensionUpdatesCheckedSchema = z.object({
    ok: z.literal(true).describe("The check ran."),
    checkedAt: z.string().describe("When, so a screen can date the answer."),
});
export const ExtensionSummarySchema = z.object({
    id: extensionId.describe("The extension's id."),
    manifest: ExtensionManifestSchema.describe("What it declares about itself: what it contributes, what it needs, and what it may reach."),
    commit: z.string().describe("Exactly which commit is installed."),
    // builtin: hides the uninstall affordance.
    // installed: shows the pinned commit.
    // workspace: "uninstalled" by deleting its directory.
    source: z
        .enum(["builtin", "installed", "workspace"])
        .describe(
            "Where the code comes from: baked into the sandbox image and not removable, installed from a repository at a pinned commit, or written in this workspace and edited in place.",
        ),
    // Persisted at .intentic/config/extension-enablement.json.
    enabled: z
        .boolean()
        .describe(
            "The owner's switch. A switched-off extension is still listed, which is what makes it switchable back on, but nothing it contributes is wired up.",
        ),
    essential: z
        .boolean()
        .optional()
        .describe(
            "Its switch is fixed on, because it is the only way to see or stop an engine the sandbox runs regardless. Hiding that page would not stop the spending, only your ability to notice it. Declared by the core about its own surfaces, never by an extension about itself, which would be a pack making itself un-removable.",
        ),
    usage: z
        .record(
            z.string(),
            z.object({ calls: z.number().int().nonnegative().describe("How many times."), last: z.string().describe("When, most recently.") }),
        )
        .optional()
        .describe(
            "How much of the reach it asked for it has actually used, keyed by what it declared. Absent means never observed doing anything, which is a different claim from uses none of them, and the two have to stay tellable apart: reading either as these permissions are unnecessary turns evidence into a guess with a number on it.",
        ),
    // starting/stopped mean the host itself is between states.
    backend: z
        .object({
            state: z
                .enum(["running", "error", "absent", "incompatible", "starting", "stopped"])
                .describe(
                    "How its server half is doing. Absent means the code is not in this image at all; incompatible means it needs a different sandbox version.",
                ),
            detail: z
                .string()
                .optional()
                .describe("What went wrong, so a backend that failed to start is a sentence rather than an address that answers nothing."),
        })
        .optional()
        .describe("Present only for an extension that ships a server half."),
    // Update lifecycle, present only for a git-installed extension (absent for builtin/workspace):
    // update: the badge.
    // advisory: the alarm.
    // health: the after-the-click watch.
    // previous: the way back (kept one-back checkout's sha).
    // updatePolicy: the owner's standing answer.
    update: ExtensionUpdateSchema.optional().describe(
        "A newer version waiting. All five of these exist only for one installed from a repository: a built-in updates with the image and one written here is edited live.",
    ),
    advisory: ExtensionAdvisorySchema.optional().describe("A security warning about the installed version."),
    health: ExtensionHealthSchema.optional().describe("How it has behaved since the last update, which is what decides whether that update sticks."),
    previous: z
        .object({
            ref: z.string().describe("The commit that was running before."),
            version: z.string().optional().describe("What it called itself."),
        })
        .optional()
        .describe("The version kept one step back, which is what going back means."),
    updatePolicy: ExtensionUpdatePolicySchema.optional().describe(
        "The owner's standing answer for this one: tell me, have an agent look, or just do it.",
    ),
});
export type ExtensionSummary = z.infer<typeof ExtensionSummarySchema>;
// Read by both the Extensions tab and an authoring agent off GET /extensions.
export const InvalidWorkspaceExtensionSchema = z.object({
    dir: z.string().describe("Which folder."),
    error: z.string().describe("Why it could not be read."),
});
export type InvalidWorkspaceExtension = z.infer<typeof InvalidWorkspaceExtensionSchema>;
export const ExtensionsListSchema = z.object({
    extensions: z.array(ExtensionSummarySchema).describe("What is installed."),
    invalid: z
        .array(InvalidWorkspaceExtensionSchema)
        .describe(
            "Extensions written here that could not be read at all. Listed rather than dropped, because there is no install moment at which to reject a broken one, so this is its only way of saying anything.",
        ),
    updatesCheckedAt: z
        .string()
        .optional()
        .describe(
            "When updates were last looked for. Absent until the first check has run. Sent so a screen can say checked an hour ago rather than presenting staleness as certainty.",
        ),
});
// Persisted at .intentic/config/extension-settings.json, keyed by extension id so a re-clone never loses them. Secret
// values are stripped from `settings`; `secretsSet` names which ones are set.
export const ExtensionSettingsSchema = z.object({
    settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).describe("The values, minus anything marked secret."),
    secretsSet: z
        .array(z.string())
        .describe("Which of its secret settings actually hold a value. Names only: the values themselves never come back."),
});
export type ExtensionSettings = z.infer<typeof ExtensionSettingsSchema>;
export const ExtensionSettingsInputSchema = z.object({
    id: z.string().describe("Which extension."),
    settings: z
        .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
        .describe("The values to write. A key the extension never declared is refused rather than quietly stored."),
});
// Persisted by publisher.name (like settings) so the choice outlives the checkout; declared processes converge in the
// same handler.
export const ExtensionEnabledInputSchema = z.object({
    id: z.string().describe("Which extension."),
    enabled: z.boolean().describe("On or off."),
});
// Identity only; what gets written is the daemon's decision, not a form filled in — shaping happens by editing the
// files afterward. Slugs match the manifest schema's shape, re-checked here because `name` becomes a directory.
export const WorkspaceExtensionCreateSchema = z.object({
    publisher: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]*$/)
        .describe("Who it is by, which together with the name makes its id."),
    name: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]*$/)
        .describe("What it is called."),
});
// `dir` is workspace-root-relative, so the caller can name files to open next.
export const WorkspaceExtensionCreatedSchema = z.object({
    id: z.string().describe("The id it was given."),
    dir: z.string().describe("Where its files are, so you can open them."),
});
// Extension id → declared entry → count since last report; counts, not events, and declared entries, not paths, since
// this answers whether a permission is earned, not logs activity. One request per batch across all extensions.
export const ExtensionUsageBatchSchema = z.object({
    reports: z
        .record(z.string(), z.record(z.string(), z.number().int().positive()))
        .describe("Each extension that called something, and the counts against the declared powers it exercised."),
});
// One declared background process, addressed by capability entry id + process name; an undeclared name is NOT_FOUND.
export const ExtensionProcessParamSchema = z.object({
    id: z.string().describe("Which extension."),
    name: z.string().describe("Which of its declared processes."),
});
export const ExtensionProcessStatusSchema = z.object({
    name: z.string().describe("Which process."),
    running: z.boolean().describe("Whether it is up. False with a port means it crashed and the supervisor is waiting to retry it."),
    port: z.number().optional().describe("The port it was given."),
    restarts: z.number().optional().describe("How many times it died and was brought back since it was started. A growing number is a service in trouble."),
    lastExitCode: z.number().optional().describe("How it last exited, when it has crashed at least once."),
    previewUrl: z.string().optional().describe("Where to open it, when it has an address."),
});
export type ExtensionProcessStatus = z.infer<typeof ExtensionProcessStatusSchema>;
