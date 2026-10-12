import { z } from "zod";

// BRINGING AN AGENT'S WORK BACK FROM A FOLDER'S OWN SANDBOX: what the machine agent's `sync changes`, `sync bring-back`,
// `sync restore` and `sync direction --json` print, and so what the editor reads off the `intentic:project` event. The
// desktop app (project.rs) runs the verb and relays its JSON whole as `result`, beside a `kind` of its own, so it
// keeps no field of these: a new one reaches the editor without a desktop release. The machine agent wrote these as
// TypeScript interfaces and the editor as its own zod, which disagreed in name (the agent's internal `held` reason
// prints as `conflict: true`).

export const ProjectDirectionSchema = z.enum(["to-sandbox", "both"]);
export type ProjectDirection = z.infer<typeof ProjectDirectionSchema>;

export const ProjectChangeKindSchema = z.enum(["added", "modified", "deleted"]);
export type ProjectChangeKind = z.infer<typeof ProjectChangeKindSchema>;

// One entry the sandbox changed that the folder has not. `size` is the sandbox copy's, what bringing it back writes;
// `conflict` marks a `modified` path changed in the folder too, which a bring-back lists but keeps the folder's copy of.
export const ProjectChangeSchema = z.object({
    path: z.string().min(1),
    kind: ProjectChangeKindSchema,
    size: z.number().optional(),
    // The agent only ever prints `true`; a reader takes any boolean.
    conflict: z.boolean().optional(),
});
export type ProjectChange = z.infer<typeof ProjectChangeSchema>;

// An entry a bring-back or restore left alone, and why (the folder's copy changed too, say).
export const ProjectSkippedSchema = z.object({ path: z.string(), reason: z.string() });
export type ProjectSkipped = z.infer<typeof ProjectSkippedSchema>;

export const ProjectAppliedSchema = z.object({ path: z.string(), kind: ProjectChangeKindSchema });
export type ProjectApplied = z.infer<typeof ProjectAppliedSchema>;

// A verb that ran and failed, in the agent's own sentence.
export const ProjectFailedSchema = z.object({ ok: z.literal(false), error: z.string() });

export const ProjectChangesResultSchema = z.object({
    ok: z.literal(true),
    // The pairing's key, which names the folder and its sandbox.
    pairing: z.string().optional(),
    direction: ProjectDirectionSchema,
    changes: z.array(ProjectChangeSchema),
    // More changes than the agent lists (its CHANGES_MAX); the rest are not named.
    truncated: z.boolean().optional(),
});
export type ProjectChangesResult = z.infer<typeof ProjectChangesResultSchema>;

export const BringBackResultSchema = z.object({
    ok: z.literal(true),
    // The restore point that undoes it.
    point: z.string().min(1),
    applied: z.array(ProjectAppliedSchema),
    skipped: z.array(ProjectSkippedSchema).optional(),
});
export type BringBackResult = z.infer<typeof BringBackResultSchema>;

export const RestoreResultSchema = z.object({
    ok: z.literal(true),
    restored: z.number(),
    // The editor only counts what a restore did, so a skipped list of a shape it does not know reads as no list rather
    // than costing the whole answer, and with it the step that waits for it.
    skipped: z.array(ProjectSkippedSchema).optional().catch(undefined),
});
export type RestoreResult = z.infer<typeof RestoreResultSchema>;

export const DirectionResultSchema = z.object({ ok: z.literal(true), direction: ProjectDirectionSchema });
export type DirectionResult = z.infer<typeof DirectionResultSchema>;

// The `intentic:project` event's detail: the verb's kind with its result, or a verb that never reached its sandbox
// (no machine agent runs on this computer, say).
export const ProjectAnswerSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("changes"), result: z.union([ProjectChangesResultSchema, ProjectFailedSchema]) }),
    z.object({ kind: z.literal("brought-back"), result: z.union([BringBackResultSchema, ProjectFailedSchema]) }),
    z.object({ kind: z.literal("restored"), result: z.union([RestoreResultSchema, ProjectFailedSchema]) }),
    z.object({ kind: z.literal("direction"), result: z.union([DirectionResultSchema, ProjectFailedSchema]) }),
    z.object({ kind: z.literal("error"), verb: z.string(), error: z.string() }),
]);
export type ProjectAnswer = z.infer<typeof ProjectAnswerSchema>;
