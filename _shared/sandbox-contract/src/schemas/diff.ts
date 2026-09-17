// diff: one side of a file diff named by its source, for the routes that answer with something other than the text
// diff itself (bytes on /diff/raw, derived text on /diff/derived).
import { z } from "zod";
import { GitDiffSideSchema } from "./git/git.js";

const path = z.string().min(1).describe("The file, relative to the repo or scope the diff belongs to.");
const repo = z.string().min(1).describe('Which repository: "root" for the workspace itself, otherwise a repo id.');

// The four pairings a review surface lists a row under; every field is a string, so the same shape rides a query string
// and the JSON body of a typed call alike.
export const DiffSourceQuerySchema = z.discriminatedUnion("source", [
    z
        .object({
            source: z.literal("working"),
            repo,
            side: GitDiffSideSchema.describe("Which git side the row came from; a half-staged file is two different diffs."),
            path,
        })
        .describe("Uncommitted work in a workspace repo, what the Changes panel lists."),
    z
        .object({
            source: z.literal("agent"),
            agent: z.string().min(1).describe("The conversation whose work is under review."),
            repo,
            path,
        })
        .describe("One agent's work against the base its review is listed against."),
    z
        .object({
            source: z.literal("commit"),
            repo,
            sha: z
                .string()
                .regex(/^[0-9a-f]{4,64}$/)
                .describe("The commit, compared against its first parent."),
            path,
        })
        .describe("A commit against its first parent."),
    z
        .object({
            source: z.literal("checkpoint"),
            snapshot: z.string().min(1).describe("Which saved point."),
            scope: z.string().min(1).describe("Which part of the workspace the path belongs to."),
            path,
        })
        .describe("A saved point in the timeline, against the visible one before it."),
]);
export type DiffSourceQuery = z.infer<typeof DiffSourceQuerySchema>;

// One side of a document rendered to text, or why it could not be. The text is fileq's rendering, the same one an
// agent reads instead of the bytes, so what a reviewer compares here is what the agent worked from.
export const DerivedSideSchema = z.discriminatedUnion("present", [
    z.object({
        present: z.literal(true),
        content: z.string().describe("The side as markdown."),
        deriver: z.string().describe("Which reader made this text, with its version."),
        notes: z.array(z.string()).describe("Every cap and degradation the conversion hit, one line each."),
        truncated: z.boolean().describe("The rendering was longer than this response carries; only its start is here."),
    }),
    z.object({
        present: z.literal(false),
        reason: z.string().describe("Why this side has no text: a format nothing reads, a broken file, a sandbox with no reader."),
    }),
]);
export type DerivedSide = z.infer<typeof DerivedSideSchema>;

// Both sides as text; an absent side is a side the diff does not have (an added file has no before).
export const DerivedDiffSchema = z.object({
    before: DerivedSideSchema.optional().describe("The file as it was, rendered to text. Absent when it did not exist yet."),
    after: DerivedSideSchema.optional().describe("The file as it is now, rendered to text. Absent when it was deleted."),
});
export type DerivedDiff = z.infer<typeof DerivedDiffSchema>;
