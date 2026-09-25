import { z } from "zod";
import { RunnerCommandFrameSchema, RunnerCommandSchema } from "../protocol/runner-protocol.js";

// OFFLOADED WORK, as the in-sandbox `offload-run` command and the editor see it (settings `offload`): a heavy line this
// sandbox hands a runner on one of the owner's machines instead of running it itself.

// Whether a runner can take a line right now, asked before the tree is snapshotted, so a machine that is asleep costs
// nothing. `name` is the machine the runner sits on, the word the owner picked it by.
export const OffloadTargetSchema = z.object({
    runner: z.string().min(1),
    name: z.string().min(1),
    ready: z.boolean(),
    // Why not, in the words the command prints before it runs the line here instead.
    why: z.string().optional(),
});
export type OffloadTarget = z.infer<typeof OffloadTargetSchema>;

export const OffloadRunSchema = RunnerCommandSchema.extend({ runner: z.string().min(1) });
export type OffloadRun = z.infer<typeof OffloadRunSchema>;

// What a run streams back: the runner's own frames, or one refusal when the runner could not take it after all (it went
// offline between the question and the run, or it predates offloading), which sends the line back here.
export const OffloadFrameSchema = z.union([...RunnerCommandFrameSchema.options, z.object({ kind: z.literal("refused"), why: z.string() })]);
export type OffloadFrame = z.infer<typeof OffloadFrameSchema>;

// One offloaded run as the runner card lists it: the recent ones, kept in memory, newest first.
export const OffloadRecordSchema = z.object({
    runId: z.string(),
    runner: z.string(),
    name: z.string(),
    label: z.string(),
    // The line, cut to a readable length.
    command: z.string(),
    startedAt: z.number(),
    endedAt: z.number().optional(),
    code: z.number().int().optional(),
    failure: z.string().optional(),
});
export type OffloadRecord = z.infer<typeof OffloadRecordSchema>;

// One kind of heavy work the owner can send elsewhere: a heavy-command rule this sandbox queues (its id, as settings
// `offload.commands` keys it) and the pattern that sorts a line into it.
export const OffloadKindSchema = z.object({ id: z.string().min(1), pattern: z.string() });
export type OffloadKind = z.infer<typeof OffloadKindSchema>;
