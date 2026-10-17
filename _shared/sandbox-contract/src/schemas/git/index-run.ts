import { z } from "zod";
import { CommandRunSchema } from "../ci.js";
import { RepoParamSchema } from "../shared.js";
import { CommitResultSchema, GitTargetSchema } from "./git.js";

// Stage-all and commit-all as runs the daemon keeps, not requests held open: over a tree of tens of thousands of
// untracked files `git add -A` alone outlives the browser's header deadline (seconds), and a request that dies there
// leaves git running with nobody told how it ended. Modelled on the push run (PushRunSchema): started and answered at
// once, polled for progress and verdict, one per repository, a second start of the same thing joining the first.

// The guardrail's line, past which a run stops before staging and asks: a stage that size is almost always a dependency
// or build tree nobody meant to commit. Either one trips it.
export const INDEX_RUN_FILE_LIMIT = 2_000;
export const INDEX_RUN_BYTE_LIMIT = 100 * 1024 * 1024;

export const IndexRunOpSchema = z.enum(["stage", "commit"]);
export type IndexRunOp = z.infer<typeof IndexRunOpSchema>;

// Where a running run is, in the order it passes them; a plain commit skips counting and staging.
// waiting: queued behind another write on the same repository (an agent's land, another commit).
// counting: reading what the stage would take, for the guardrail.
// staging / committing: git is running.
// reading: re-reading the repository the commit just wrote, for the answer.
export const IndexRunPhaseSchema = z.enum(["waiting", "counting", "staging", "committing", "reading"]);

export const IndexRunDirSchema = z.object({
    dir: z.string().describe("A top-level directory of the repository, or an empty string for the files directly at its root."),
    files: z.number().describe("How many of the files the stage would take sit under it."),
    bytes: z.number().optional().describe("Their combined size on disk. Absent when the run did not measure sizes, which it skips once the file count alone is over the line."),
});
export type IndexRunDir = z.infer<typeof IndexRunDirSchema>;

// What a held run found, so the question names the directories rather than only a number.
export const IndexRunHoldSchema = z.object({
    files: z.number().describe("How many files the stage would take."),
    bytes: z.number().optional().describe("Their combined size on disk, when measured."),
    dirs: z.array(IndexRunDirSchema).describe("The largest top-level directories among them, biggest first, at most a handful."),
});
export type IndexRunHold = z.infer<typeof IndexRunHoldSchema>;

// Flat rather than a union on `op`: the route's path parameter merges into the input, which a discriminated union cannot
// take, and the one cross-field rule (a commit needs a message) is a refine.
export const IndexRunStartSchema = RepoParamSchema.extend({
    op: IndexRunOpSchema.describe("Stage, or commit (staging `target` first when given)."),
    target: GitTargetSchema.optional().describe(
        "What to stage. For a stage, leave it out for the whole repository. For a commit, leave it out to record the index exactly as it stands, or give an empty object to stage everything first.",
    ),
    message: z.string().min(1).optional().describe("The commit message. Required for a commit, refused for a stage."),
    confirmed: z
        .boolean()
        .optional()
        .describe(
            `Go ahead past the guardrail. Without it, a stage that would take more than ${String(INDEX_RUN_FILE_LIMIT)} files or ${String(INDEX_RUN_BYTE_LIMIT / 1024 / 1024)} MB stops before touching the index and settles holding what it found, for a person to confirm.`,
        ),
})
    .refine((start) => start.target === undefined || start.target.paths === undefined || start.target.scope === undefined, {
        message: "name paths or a scope, not both",
    })
    .refine((start) => (start.op === "commit") === (start.message !== undefined), { message: "a commit takes a message and a stage does not" });
export type IndexRunStart = z.infer<typeof IndexRunStartSchema>;

export const IndexRunSchema = CommandRunSchema.extend({
    id: z.string().describe("This run's own id, new on every start that did not join one already going. Empty when idle."),
    repo: z.string().describe("The repository this run is about, the same id the routes take."),
    op: IndexRunOpSchema.optional().describe("What was started. Absent when idle."),
    phase: IndexRunPhaseSchema.optional().describe("Where a running run is. Absent once it settles."),
    files: z
        .object({
            total: z.number().optional().describe("How many files the stage takes, once counted."),
            done: z.number().optional().describe("How many of them are staged so far. git stages a whole repository in one go, so this jumps from 0 to the total."),
        })
        .optional()
        .describe("Progress in files, where known."),
    reason: z.string().optional().describe("Why it did not go, in git's own words where git said something."),
    held: IndexRunHoldSchema.optional().describe(
        "Present when the run stopped at the guardrail before touching anything (status `error`): what it would have staged. Start again with `confirmed` to go ahead.",
    ),
    result: CommitResultSchema.optional().describe("A commit's answer, the same one the commit call gives, once it passes."),
});
export type IndexRun = z.infer<typeof IndexRunSchema>;
