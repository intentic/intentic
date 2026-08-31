// extensions: installed extension-kind capabilities resolved to their manifests
// extension updates: what the registry check found, and what the owner decided to do about such findings
import { z } from "zod";
import { ExtensionManifestSchema } from "@intentic/extension-manifest";
// What the web extension host boots from: each row is an extension capability whose checkout still parses,
// the approved manifest (contribution declarations), and the checked-out commit (the code identity; the bundle
// route's ETag). A rotted checkout is skipped here; its capability row still shows status.
// The routing handle: a git-installed extension uses its capability entry id; an image-baked one has no
// capability entry and is addressed by the manifest-derived publisher.name, hence the dot in the pattern.
const extensionId = z
    .string()
    .min(1)
    .max(121)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
// The owner's per-extension update posture. `updates` is the ladder: `notify` (badge and wait, the default),
// `agent` (the discovery also prepares an agent diff-read of the new sha), `auto` (apply unattended, but only
// a verified listing whose powers didn't grow, health-watched with auto-revert, anything less falls back to
// notify). `advisories` is separate because its safe direction is the opposite: disabling runs no new code, so
// `auto-disable` is the default and `notify` is the opt-out.
export const ExtensionUpdatePolicySchema = z.object({
    updates: z.enum(["notify", "agent", "auto"]),
    advisories: z.enum(["auto-disable", "notify"]),
});
export type ExtensionUpdatePolicy = z.infer<typeof ExtensionUpdatePolicySchema>;
// A newer sha the registry lists for an installed extension, the "update available" badge's substance. The
// pointer (url/path) rides along because updating follows the ROW as it stands now, not the install as it was.
export const ExtensionUpdateSchema = z.object({
    ref: z.string().describe("The commit being offered."),
    version: z.string().optional().describe("What it calls itself."),
    url: z.string().describe("Where it comes from."),
    path: z.string().optional().describe("Where inside that repository it lives."),
    trust: z.enum(["verified", "listed"]).describe("Whether anybody vouched for it, or it is merely listed."),
    // The listing says this release fixes a security problem in earlier ones, the badge goes loud, because
    // here the OLD version is the dangerous one.
    securityFix: z
        .boolean()
        .optional()
        .describe("This release fixes a security problem in earlier ones, so here the old version is the dangerous one."),
    registry: z.string().describe("Which registry said so."),
    at: z.string().describe("When it was published."),
    // Why the auto rung refused this one and fell back to notify ("powers grew", "not verified"), the card
    // leads with it so the owner knows the click is theirs for a reason.
    needsReview: z
        .string()
        .optional()
        .describe(
            "Why this one was not taken automatically and is asking for a person instead: it wants more than it used to, or nobody has vouched for it.",
        ),
    // The agent-prepared rung's work: the conversation where the owner's agent already read the diff between
    // the installed sha and this one. The card links it instead of offering to start it.
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
// The registry blocked this installed extension's listing. Delisting protects people browsing; this record is
// for the person already running it, the reason verbatim, and whether the daemon already pulled the switch.
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
// The post-update watch: validation catches broken, not wrong, so for a minute after a swap the daemon checks
// that what the new version declared actually came up (autoStart processes running, backend activated).
// `fromRef` is the sha the kept-previous checkout holds, what a revert returns to.
export const ExtensionHealthSchema = z.object({
    state: z
        .enum(["watching", "healthy", "unhealthy"])
        .describe("How it has behaved since the last update. Checks catch broken, not wrong, so for a while after a swap it is simply watched."),
    detail: z.string().optional().describe("What is going wrong, when something is."),
    fromRef: z.string().optional().describe("Which version it was updated from, which is what going back would return to."),
    at: z.string().describe("When the watching started."),
    // The auto rung's failure path already ran: the update was rolled back unattended, and the record stays to
    // say so rather than pretending the attempt never happened.
    autoReverted: z
        .boolean()
        .optional()
        .describe("The update was already rolled back without anybody asking. The record stays rather than pretending the attempt never happened."),
});
export type ExtensionHealth = z.infer<typeof ExtensionHealthSchema>;
// The mechanical comparison of two manifests' declared reach (extension-manifest's diffPowers), plain
// sentences, so the update dialog renders exactly what approval is being asked to cover.
export const PowersDiffSchema = z.object({
    added: z.array(z.string()).describe("What the new version asks for that the running one does not. The whole point of the comparison."),
    removed: z.array(z.string()).describe("What it no longer asks for."),
    unchanged: z.array(z.string()).describe("What stays the same."),
});
export type PowersDiff = z.infer<typeof PowersDiffSchema>;
// What an owner reads before clicking Update: the offered sha's manifest folded to the version story, the
// engines verdict, and the powers diff against the installed manifest. `ref` optional on the way in, absent
// means "the update the check recorded", which is the only caller most of the time.
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
// `rebuildNeeded` (update only): the new version's environment fragment changed the composed overlay, so the
// card must say a one-time image rebuild is pending rather than let the update read as wholly landed.
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
    /* Where the code comes from, which is also what the web varies per row: `builtin` (image-baked, no git
     * checkout, not removable) hides the uninstall affordance, `installed` (a git capability) shows the pinned
     * commit, `workspace` (a directory under .intentic/config/workspace-extensions/, created and edited in place,
     * typically by an agent) is "uninstalled" by deleting its directory. */
    source: z
        .enum(["builtin", "installed", "workspace"])
        .describe(
            "Where the code comes from: baked into the sandbox image and not removable, installed from a repository at a pinned commit, or written in this workspace and edited in place.",
        ),
    // The owner's switch (.intentic/config/extension-enablement.json). A disabled extension is still listed, that's
    // what makes it switchable back on, but the daemon wires none of its contributions up and the web host
    // doesn't activate it.
    enabled: z
        .boolean()
        .describe(
            "The owner's switch. A switched-off extension is still listed, which is what makes it switchable back on, but nothing it contributes is wired up.",
        ),
    /* THE SWITCH IS FIXED ON, this extension is the only control surface for an engine the daemon runs
     * regardless. The automations scheduler fires turns on a clock whether or not anything draws them, and
     * hiding the one page that can see, stop or approve those fires would not stop the spend, it would only
     * remove the owner's ability to notice it. So the daemon refuses the flip, and the tab draws the switch as
     * fixed with this fact as the reason.
     *
     * Declared by the CORE about its own engines' surfaces, never by a manifest: a field an extension could set
     * on itself would be a pack making itself un-removable, which is a self-granted privilege the approval flow
     * exists to prevent. */
    essential: z
        .boolean()
        .optional()
        .describe(
            "Its switch is fixed on, because it is the only way to see or stop an engine the sandbox runs regardless. Hiding that page would not stop the spending, only your ability to notice it. Declared by the core about its own surfaces, never by an extension about itself, which would be a pack making itself un-removable.",
        ),
    /* How much of the reach this extension asked for it has actually used, keyed by the DECLARED entry so a row
     * joins straight onto `permissions.sandbox`. Absent for an extension that has never been observed calling
     * anything, which is a different claim from "uses none of them" and has to stay tellable: a freshly installed
     * extension has an empty ledger and an unexercised one does too, and reading either as "these permissions are
     * unnecessary" would turn this from evidence into a guess with a number on it. */
    usage: z
        .record(
            z.string(),
            z.object({ calls: z.number().int().nonnegative().describe("How many times."), last: z.string().describe("When, most recently.") }),
        )
        .optional()
        .describe(
            "How much of the reach it asked for it has actually used, keyed by what it declared. Absent means never observed doing anything, which is a different claim from uses none of them, and the two have to stay tellable apart: reading either as these permissions are unnecessary turns evidence into a guess with a number on it.",
        ),
    /* The BACKEND half's state, present only for an extension whose manifest ships a `server` bundle: what the
     * daemon's backend host reports for it (running / an activation error with its message), or what only the
     * daemon can know (absent, the code is not in this image; incompatible, its engines exclude this daemon;
     * starting/stopped, the host itself is between states). The tab renders it beside the row so a backend
     * that failed to activate is a sentence, not a namespace that 404s. */
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
    /* The update lifecycle, present only where it can exist, a git-installed extension. `update` is the badge,
     * `advisory` the alarm, `health` the after-the-click watch, `previous` the way back (the kept one-back
     * checkout's sha), `updatePolicy` the owner's standing answer. A builtin updates with the image and a
     * workspace one is live-edited, so all five stay absent for them. */
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
// A workspace-extension directory that failed to enumerate, and why. Its only feedback channel: there is no
// install moment to reject a bad manifest, so the parse failure (or id collision) rides the list instead of
// silently dropping the row, the Extensions tab renders it, and an authoring agent reads it off GET /extensions.
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
    // When the registry comparison last ran, absent until the first check completes. Serving it on the list is
    // what lets the tab say "checked an hour ago" instead of presenting staleness as certainty.
    updatesCheckedAt: z
        .string()
        .optional()
        .describe(
            "When updates were last looked for. Absent until the first check has run. Sent so a screen can say checked an hour ago rather than presenting staleness as certainty.",
        ),
});
// The extension's contributes.settings values, persisted daemon-side (.intentic/config/extension-settings.json) keyed
// by the manifest-derived extension id, the checkout stays pristine, so a re-clone update never loses them.
// Secret-marked values are stripped from `settings`; `secretsSet` lists the secret keys that DO hold a value,
// so the UI renders "•••• (set)" without ever receiving the secret back.
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
// Flip one extension on or off. Persisted by publisher.name (like settings), so the choice outlives the
// checkout; the daemon's immediate half of the flip, declared processes, converges in the same handler.
export const ExtensionEnabledInputSchema = z.object({
    id: z.string().describe("Which extension."),
    enabled: z.boolean().describe("On or off."),
});
/* Create a workspace extension: the identity, and deliberately nothing else. What gets written is the daemon's
 * decision, not a form the author fills in, the point of the action is that a running extension exists a second
 * after it is asked for, and shaping it happens by editing the files it wrote (or by asking an agent to). The two
 * slugs are the same shape the manifest schema demands, checked again here because `name` becomes a directory. */
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
// Where it landed. `dir` is workspace-root-relative so the caller can name the files it should open next.
export const WorkspaceExtensionCreatedSchema = z.object({
    id: z.string().describe("The id it was given."),
    dir: z.string().describe("Where its files are, so you can open them."),
});
/* A batch of calls the host observed against this extension's declared routes, entry → how many since the last
 * report. Counts rather than events, and declared entries rather than concrete paths, because the question the
 * ledger answers is "is this permission earned?": a finer record would be a log of what the owner was doing,
 * indexed by extension, which is not a thing this product should be accumulating to answer it. */
export const ExtensionUsageInputSchema = z.object({
    id: z.string().describe("Which extension."),
    used: z.record(z.string(), z.number().int().positive()).describe("Which of its declared powers it exercised, and how many times."),
});
// One declared background process (contributes.processes), status/start/stop, addressed by the capability
// entry id + the manifest's process name. Undeclared names are NOT_FOUND, the manifest-honesty rule again.
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
