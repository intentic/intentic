import { z } from "zod";
import { NeedsActionSchema } from "../policy/needs-action.js";

// Anything entering the sandbox, any source or format, goes through one pipeline: source to plan (ticked by the owner),
// apply (re-derived from the held bytes), report (what landed). The outbound half lives in definition.ts and
// schemas/environment.ts.

// Two assistant members rather than one "foreign", so the checklist can badge the source by name.
export const ArrivalSourceSchema = z.enum(["definition", "bundle", "hermes", "openclaw"]);
export type ArrivalSource = z.infer<typeof ArrivalSourceSchema>;

// Narrower than ArrivalSource: a connected device is scanned for these two only, never for a bundle.
export const AssistantSourceSchema = z.enum(["hermes", "openclaw"]);
export type AssistantSource = z.infer<typeof AssistantSourceSchema>;

// What an item becomes here, not what it was there: the apply dispatches on this and the checklist groups by it. One
// enum across every source, so a repo means the same thing whichever way it arrived.
export const ArrivalGroupSchema = z.enum([
    // The /work tree as a whole, cloned from the remote a definition's `[workspace]` names.
    "workspace",
    // One repository: cloned from its remote, or unpacked with its real git dir from a bundle.
    "repo",
    // Loose files landing in /work: a bundle's workspace bytes, an assistant's notes folder.
    "files",
    // Transcripts, checkpoint timelines, ledgers. Bundle-only — nothing else can reference them.
    "history",
    // The overlay Dockerfile.
    "environment",
    // One connection, landing unauthenticated unless its secret travelled.
    "capability",
    // The agent settings that differ from their defaults.
    "settings",
    // A merge into the workspace's memory file.
    "memory",
    "skill",
    "automation",
    // One credential VALUE, and the only group gated behind the apply's second consent.
    "secret",
]);
export type ArrivalGroup = z.infer<typeof ArrivalGroupSchema>;

// Two flags, not one: the four sources fail an item for two different reasons.
// applicable: false when the target already holds this; it cannot be ticked.
// recommended: false when it can be ticked but the reader should look first.
export const ArrivalItemSchema = z.object({
    // Deterministic, derived from the artifact ("repo:intentic"), so a re-derived plan names the same items.
    id: z.string(),
    group: ArrivalGroupSchema,
    // The checklist line in plain words ("Repository intentic", "Skill, weather").
    label: z.string(),
    detail: z.string().optional(),
    applicable: z.boolean(),
    // Why it cannot be ticked; present exactly when applicable is false.
    reason: z.string().optional(),
    recommended: z.boolean(),
    // Names of secrets this row would store, never values; moves only when apply sets includeSecrets.
    secrets: z.array(z.string()),
});
export type ArrivalItem = z.infer<typeof ArrivalItemSchema>;

export const ArrivalPlanSchema = z.object({
    source: ArrivalSourceSchema,
    // Names the held artifact for apply; minted per plan, a new plan replaces the held one.
    token: z.string(),
    // What the artifact calls itself (a definition's name, a bundle's source sandbox); for display only.
    name: z.string().optional(),
    items: z.array(ArrivalItemSchema),
    // Whether the artifact holds credential values at all; the card only asks the second consent when true.
    carriesSecrets: z.boolean(),
    // What the reader saw but won't offer (sessions, logs, pairing state, a refused entry); listed, not silent.
    refused: z.array(z.string()),
    // Known not to move mechanically, shown at preview so the owner ticks knowingly, and again in the report.
    needsAction: z.array(NeedsActionSchema),
});
export type ArrivalPlan = z.infer<typeof ArrivalPlanSchema>;

export const ArrivalApplySchema = z.object({
    token: z.string(),
    // The ticked ids; ones missing from the re-derived plan are ignored rather than erroring.
    items: z.array(z.string()),
    // The owner's explicit consent to move credential values, asked once on the inbound side, for every source.
    includeSecrets: z.boolean(),
});
export type ArrivalApply = z.infer<typeof ArrivalApplySchema>;

export const ArrivalReportSchema = z.object({
    applied: z.array(z.object({ id: z.string(), group: ArrivalGroupSchema, label: z.string() })),
    // Ticked but didn't land, each with its reason; distinct from refused rows, which were never attempted.
    failed: z.array(z.object({ id: z.string(), label: z.string(), error: z.string() })),
    refused: z.array(z.string()),
    needsAction: z.array(NeedsActionSchema),
    // The source's presentation, when the artifact carried it: what its owner called it and its switcher logo. The
    // daemon cannot apply these itself — they are platform rows, and it holds no owner session — so they are handed
    // back for the caller that does. Absent for every artifact that carries none.
    presentation: z.object({ name: z.string().optional(), image: z.string().optional() }).optional(),
});
export type ArrivalReport = z.infer<typeof ArrivalReportSchema>;

// One of the owner's own devices: the daemon walks its home folder over the socket it already holds, no packing needed.
// found absent means connected with nothing to bring in, not an error.
export const ArrivalHostSchema = z.object({
    id: z.string(),
    online: z.boolean(),
    found: AssistantSourceSchema.optional(),
    // Why this machine can't be read right now (asleep, or its own refusal), in its own words.
    detail: z.string().optional(),
});
export type ArrivalHost = z.infer<typeof ArrivalHostSchema>;
export const ArrivalHostsSchema = z.object({ hosts: z.array(ArrivalHostSchema) });

// Reads a setup off a connected device instead of an upload; answers with a plan exactly like the upload door does.
export const ArrivalScanSchema = z.object({ host: z.string().min(1) });
export type ArrivalScan = z.infer<typeof ArrivalScanSchema>;
