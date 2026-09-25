// main-line checks: the whole-tree check the daemon runs after work lands, and what became of what it found
import { z } from "zod";

// Nothing is verified inside a conversation any more: a turn ends when the model says it is done, its work lands, and
// the main tree's own check runs afterwards, off everyone's clock, one project at a time. This is that check as the
// editor reads it: what is being measured, what is waiting, what the last run said, and who is working on a red one.

export const MainlineLandSchema = z.object({
    conversationId: z.string().describe("The conversation whose work landed."),
    title: z.string().optional().describe("Its title when it landed."),
    at: z.number().describe("When the land asked for the check, in milliseconds."),
});
export type MainlineLand = z.infer<typeof MainlineLandSchema>;

// What happened to a red verdict's failures, decided once the lands behind it had their own check.
export const MainlineRoutingKindSchema = z.enum([
    // More work landed while this ran; the check that measures it decides, so nobody is sent after a failure it may fix.
    "waiting",
    // A conversation still working touches what failed; nobody else is started until it stops.
    "held",
    // Sent back to the conversation that landed it, which still had the work in mind.
    "original",
    // A fresh conversation was started on it with the failures, the suspects' changes and where to read their sessions.
    "fix-up",
    // Nobody was sent: repairs are switched off, or no conversation could take it. An automation may.
    "reported",
    // Gone at the next check, before anybody was sent.
    "resolved",
    // The sends and fresh attempts a red streak allows are used up; it waits for a person.
    "spent",
]);
export type MainlineRoutingKind = z.infer<typeof MainlineRoutingKindSchema>;

export const MainlineRoutingSchema = z.object({
    kind: MainlineRoutingKindSchema.describe("What became of the failures."),
    conversationId: z
        .string()
        .optional()
        .describe("The conversation working on them (the original or a fresh one), or the one still working that the repair waits for."),
    at: z.number().describe("When that was decided, in milliseconds."),
    detail: z.string().optional().describe("One sentence on why, in the sandbox's words."),
});
export type MainlineRouting = z.infer<typeof MainlineRoutingSchema>;

// The first failures a run names; the whole list stays in its terminal.
export const MAINLINE_FAILURES_KEPT = 30;

export const MainlineRunSchema = z.object({
    project: z.string().describe("Which project, by folder relative to the workspace. Empty is the workspace root."),
    command: z.string().describe("What ran."),
    status: z.enum(["green", "red"]).describe("How it ended."),
    startedAt: z.number().describe("When it started, in milliseconds."),
    at: z.number().describe("When it ended, in milliseconds."),
    lands: z.array(MainlineLandSchema).describe("The lands it answered for, oldest first. Empty for a run no land asked for."),
    failures: z.array(z.string()).describe(`The first failures it named, at most ${MAINLINE_FAILURES_KEPT}.`),
    failureCount: z.number().describe("How many failures it named in all. Zero on a red run that wrote no list."),
    attempt: z.number().describe("How many red runs in a row this is for the project; zero when green."),
    suspects: z
        .array(z.string())
        .optional()
        .describe("The conversations whose lands these failures were laid at, when any could be named."),
    routing: MainlineRoutingSchema.optional().describe("What became of a red run's failures. Absent on green, and until it is decided."),
});
export type MainlineRun = z.infer<typeof MainlineRunSchema>;

export const MainlineProjectSchema = z.object({
    project: z.string().describe("Which project, by folder relative to the workspace. Empty is the workspace root."),
    running: z
        .object({
            command: z.string().describe("What is running."),
            startedAt: z.number().describe("When it started, in milliseconds."),
            lands: z.array(MainlineLandSchema).describe("The lands it answers for."),
        })
        .optional()
        .describe("The check running on it now, if any."),
    queued: z.array(MainlineLandSchema).describe("Lands waiting for the next check, which will measure them together."),
    last: MainlineRunSchema.optional().describe("Its most recent settled check."),
    redSince: z.number().optional().describe("When its checks went red and stayed so, in milliseconds. Absent while green."),
});
export type MainlineProject = z.infer<typeof MainlineProjectSchema>;

export const MainlineStatusSchema = z.object({
    projects: z.array(MainlineProjectSchema).describe("Every project a land has been checked in, or is waiting to be."),
    recent: z.array(MainlineRunSchema).describe("The latest settled checks across every project, newest first."),
});
export type MainlineStatus = z.infer<typeof MainlineStatusSchema>;
