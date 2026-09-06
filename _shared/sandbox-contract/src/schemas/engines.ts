// engines: the upstream agent programs this sandbox spawns, and which version of each it runs
import { z } from "zod";

/* AN ENGINE IS THE PROGRAM A RUNTIME RIDES ON, which is a different noun from `runtime` and has to stay one.
 *
 * `runtime` (agent-catalog.ts) is the LOOP: claude-code, codex, opencode, acp, pi, cursor — what shape a turn
 * has. An engine is the installed PROGRAM that loop spawns or imports: the `claude` binary and its SDK, the
 * `codex` wrapper, `@cursor/sdk`, the `opencode` binary, the `cli-proxy-api` translator. One engine can back
 * several runtimes (the translator serves Gemini, Kimi and ChatGPT; Kimi runs under the Claude Code loop), so
 * the two lists are neither the same set nor the same question.
 *
 * The distinction earns its keep because engines have a lifecycle runtimes do not: they are published upstream,
 * on somebody else's schedule, and until this existed the only way to move one was to ship a sandbox image.
 * That made an ordinary upstream event — Anthropic raising the version floor a model requires — into a support
 * problem: every sandbox in the fleet failed every Claude turn until a new image reached it.
 *
 * So an engine version now comes from a STORE on the daemon volume, and the image's copy is the floor beneath
 * it. The blessed list says which version this project has actually run its suite against; an owner who wants
 * upstream's newest without waiting for that says so per engine. */

export const ENGINE_IDS = ["claude", "codex", "cursor", "opencode", "translator"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];
export const EngineIdSchema = z.enum(ENGINE_IDS);

/* THE OWNER'S STANDING ANSWER for one engine, and the whole of the version policy.
 *
 *   blessed , the default: whatever the blessed list names, which is a version this project's CI has run
 *              against. Data, not an image, so blessing a version reaches a running sandbox in seconds.
 *   latest  , upstream's newest published version, taken without waiting for anyone to bless it. The opt-in
 *              for an owner who would rather have the fix than the assurance.
 *   pinned  , exactly this version, until they say otherwise. What a revert leaves behind, and what somebody
 *              debugging a regression wants.
 *   image   , do not use the store at all: run what the image bakes. The way back to a stock sandbox. */
export const EngineChannelSchema = z.object({
    kind: z.enum(["blessed", "latest", "pinned", "image"]).describe("Where this engine's version comes from."),
    version: z.string().optional().describe("Which version, when it is pinned to one."),
});
export type EngineChannel = z.infer<typeof EngineChannelSchema>;

// A version the store installed and then refused, with the reason it was refused. Kept per engine so a bad
// publish is not retried on a timer forever, and so the card can say why the sandbox is back on the image's
// copy rather than leaving that as an unexplained downgrade.
export const EngineQuarantineSchema = z.object({
    version: z.string().describe("Which version was refused."),
    reason: z.string().describe("What was wrong with it: it would not launch, or it did not export what the daemon calls."),
    at: z.string().describe("When it was refused."),
});
export type EngineQuarantine = z.infer<typeof EngineQuarantineSchema>;

// One engine as the Environment card draws it: what is running, what is on offer, and what the ways out are.
export const EngineRowSchema = z.object({
    id: EngineIdSchema.describe("Which engine."),
    label: z.string().describe("What it is called on screen."),
    running: z
        .object({
            // Absent means this sandbox has no copy of the engine at all: a core image bakes no provider packs,
            // and until the store installs one, a turn on that provider cannot start. Different from "running
            // the image's copy", and the card says so rather than drawing a blank version.
            version: z.string().optional().describe("The version a turn would use right now. Absent means there is no copy of this engine here yet."),
            source: z
                .enum(["image", "store"])
                .describe("Whether that version is the one baked into the sandbox image or one the store installed over it."),
        })
        .describe("What a turn started now would actually run."),
    baked: z
        .string()
        .optional()
        .describe("The version the image bakes, which is the floor everything else falls back to. Absent on an image that carries no copy of it."),
    channel: EngineChannelSchema.describe("The owner's standing answer for this engine."),
    // What the channel would move to, absent when the running version is already it. Carries whether the
    // blessed list names it, because on `latest` the answer is routinely no and the row has to say so.
    offered: z
        .object({
            version: z.string().describe("The version this engine would move to."),
            blessed: z.boolean().describe("Whether the blessed list names this version, which on the latest channel is routinely no."),
        })
        .optional()
        .describe("A newer version waiting, absent when the running one is already what the channel asks for."),
    blessed: z.string().optional().describe("What the blessed list names for this engine, when the list has been read."),
    // The store keeps one version back so a revert is a pointer move rather than a download. Absent on an
    // engine that has only ever run the image's copy.
    previous: z.string().optional().describe("The version kept one step back, which is what going back means."),
    quarantined: z.array(EngineQuarantineSchema).describe("Versions the store installed and then refused, with the reason."),
    diskBytes: z.number().int().nonnegative().describe("What this engine's kept versions cost on the daemon's volume."),
    installing: z.boolean().optional().describe("Whether this engine is currently being installed in the background."),
});
export type EngineRow = z.infer<typeof EngineRowSchema>;

export const EnginesViewSchema = z.object({
    engines: z.array(EngineRowSchema).describe("Every engine this sandbox can run, whether or not the store holds anything for it."),
    checkedAt: z.string().optional().describe("When upstream was last asked what it publishes. Absent until the first check has run."),
    listSource: z.string().describe("Where the blessed list is read from, so a self-hosted sandbox can show its own."),
    listReadAt: z.string().optional().describe("When that list was last read. Absent means it has never been reachable from here."),
});
export type EnginesView = z.infer<typeof EnginesViewSchema>;

export const EngineChannelInputSchema = z.object({
    id: EngineIdSchema.describe("Which engine."),
    kind: z.enum(["blessed", "latest", "pinned", "image"]).describe("Where its version should come from."),
    version: z.string().optional().describe("Which version, required when pinning and ignored otherwise."),
});

/* Install and activate a version now. `version` absent means what the channel offers, which is the button on
 * the row. Naming one explicitly is the "update anyway" path: it installs a version the blessed list does not
 * name, which is how a sandbox gets past an upstream version floor that the list has not caught up with. */
export const EngineUpdateInputSchema = z.object({
    id: EngineIdSchema.describe("Which engine."),
    version: z
        .string()
        .optional()
        .describe("Which version. Leave it out for whatever the channel offers; naming one takes a version nobody has blessed, deliberately."),
    /* The other half of the update-anyway path: a turn that died on an upstream version floor knows the floor
     * and not which published version satisfies it. Sending the floor lets the daemon answer that — it takes
     * the LOWEST version at or above it, the smallest step that works — rather than making a browser walk a
     * registry to fill in a version number. */
    floor: z
        .string()
        .optional()
        .describe("Install the lowest published version at or above this one. What a turn refused for being too old sends back."),
});
export const EngineRevertInputSchema = z.object({ id: EngineIdSchema.describe("Which engine.") });

export const EngineAppliedSchema = z.object({
    ok: z.literal(true).describe("It went through."),
    version: z.string().describe("Which version is now active."),
    source: z.enum(["image", "store"]).describe("Whether that is the image's copy or the store's."),
    // An engine loaded in-process (the Claude SDK's JavaScript half, @cursor/sdk) is picked up by the NEXT
    // turn rather than by the one that pressed the button: a turn already running holds the module it loaded.
    fromNextTurn: z.boolean().describe("Whether the change reaches turns already in flight, or only the next one."),
});
