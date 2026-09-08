// engines: the upstream agent programs this sandbox spawns, and which version of each it runs
import { z } from "zod";

// An engine is the installed program a runtime (agent-catalog.ts) spawns or imports — the `claude` binary, `codex`
// wrapper, `@cursor/sdk`, `opencode`, `cli-proxy-api` — not the loop itself; one engine can back several runtimes.

export const ENGINE_IDS = ["claude", "codex", "cursor", "opencode", "translator"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];
export const EngineIdSchema = z.enum(ENGINE_IDS);

// The owner's standing answer for one engine, the whole version policy:
// blessed (default): whatever the blessed list names, a version this project's CI has run against.
// latest: upstream's newest published version, without waiting for it to be blessed.
// pinned: exactly this version until changed.
// image: ignore the store; run what the image bakes.
export const EngineChannelSchema = z.object({
    kind: z.enum(["blessed", "latest", "pinned", "image"]).describe("Where this engine's version comes from."),
    version: z.string().optional().describe("Which version, when it is pinned to one."),
});
export type EngineChannel = z.infer<typeof EngineChannelSchema>;

// A version the store installed and then refused; kept per engine so a bad publish is not retried forever and the card
// can explain a downgrade.
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
            // Different from running the image's copy: absent means no copy of the engine exists here at all.
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
    // On the `latest` channel, `blessed` is routinely false; the row must still say so.
    offered: z
        .object({
            version: z.string().describe("The version this engine would move to."),
            blessed: z.boolean().describe("Whether the blessed list names this version, which on the latest channel is routinely no."),
        })
        .optional()
        .describe("A newer version waiting, absent when the running one is already what the channel asks for."),
    blessed: z.string().optional().describe("What the blessed list names for this engine, when the list has been read."),
    // Store keeps one version back so a revert is a pointer move; absent if only the image's copy ever ran.
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

// Install and activate a version now; absent `version` means whatever the channel offers. Naming one explicitly is
// "update anyway": a version the blessed list does not (yet) name.
export const EngineUpdateInputSchema = z.object({
    id: EngineIdSchema.describe("Which engine."),
    version: z
        .string()
        .optional()
        .describe("Which version. Leave it out for whatever the channel offers; naming one takes a version nobody has blessed, deliberately."),
    // Daemon installs the lowest published version at or above this floor, the smallest step that satisfies it.
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
    // An in-process engine (`@cursor/sdk`) is picked up by the next turn; a running turn keeps its module.
    fromNextTurn: z.boolean().describe("Whether the change reaches turns already in flight, or only the next one."),
});
