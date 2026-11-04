// What a land answers and takes: the conflicts that stopped it, its outcome, and the modes and spans a land can be asked
// for. Apart from agents.ts, which re-exports every name here, so a conversation's summary and the land press's own
// shapes are not one file.
import { z } from "zod";

// Why a path would not land:
// workspace: your own uncommitted edits are on that path
// diverged: the main tree's committed content moved under the agent since it branched; nothing of yours is at risk
// binary: git cannot three-way merge the file at all
// The roster carries the causes too (agents.ts `conflictCauses`): a card cannot offer the press that clears a refusal
// without knowing whose refusal it is.
export const LandConflictReasonSchema = z.enum(["workspace", "diverged", "binary"]);
export type LandConflictReason = z.infer<typeof LandConflictReasonSchema>;
export const LandConflictPathSchema = z.object({
    path: z.string().describe("Which file."),
    reason: LandConflictReasonSchema.describe(
        "Why it would not merge, and the three have nothing in common but the symptom. Your own uncommitted edits on that path, where yours is the copy at risk. The shared tree having moved under the conversation since it started, where nothing of yours is at risk. Or a file git cannot merge at all, where no automatic answer exists.",
    ),
});
// `paths` are files that genuinely failed to apply, not the whole delta; empty `paths` with `clean: 0` means the repo
// itself was unreachable.
export const LandConflictSchema = z.object({
    repo: z.string().describe("Which repository."),
    paths: z
        .array(LandConflictPathSchema)
        .describe(
            "The files that genuinely would not apply. Not the whole change: reporting everything whenever the cause could not be pinned down turned four real conflicts into a wall of fourteen.",
        ),
    clean: z
        .number()
        .describe(
            "How many files in this repository passed but remain held with the refused composition. Zero alongside an empty list means the repository could not be reached at all.",
        ),
    // The branch to rebase onto; carried since an isolated turn's worktree hides it from the agent's own view.
    mainBranch: z
        .string()
        .optional()
        .describe(
            "The branch your own checkout is on, which is what the conversation has to rebase onto. Carried because only the sandbox can see it. Absent where there is no name to give.",
        ),
});
export type LandConflict = z.infer<typeof LandConflictSchema>;
// Land's outcome for the whole composed change: the ordinary mode preflights every repo, all-or-nothing, so a refusal
// leaves the tree untouched. `resolving` only appears for a `merge` land, whose conflict markers the user finishes by
// hand.
export const LandResultSchema = z.object({
    landed: z.boolean().describe("Whether the entire composed change was applied."),
    // Merged and nothing moved is the one outcome with nothing to show for itself; without this the caller cannot tell
    // it from a merge that carried work, and a press that did nothing looked exactly like a press that worked.
    changed: z
        .boolean()
        .describe(
            "Whether anything actually moved. False alongside merged means there was nothing on the branch to apply: the work is already in your tree, or the branch never carried any.",
        ),
    conflicts: z.array(LandConflictSchema).optional().describe("What stopped the whole composed change, grouped per repository."),
    resolving: z
        .array(
            z.object({
                repo: z.string().describe("Which repository."),
                paths: z.array(z.string()).describe("Which files now hold conflict markers to sort out by hand."),
            }),
        )
        .optional()
        .describe("Files left half-merged when you asked to carry the whole composition with its conflicts marked for resolution."),
    // A `measure` outcome with work still on the branch; `landed: false` alone can't say that, since alone it means
    // refusal.
    held: z
        .boolean()
        .optional()
        .describe(
            "Nothing was applied and nothing failed: there is work waiting on the branch for a deliberate merge. Not merged on its own cannot say that, because on its own it means refused.",
        ),
});
export type LandResult = z.infer<typeof LandResultSchema>;
// check: safe default, preflights every repo and applies only if all of it does, so a refusal leaves the tree
// byte-identical
// merge: opt-in escape hatch; three-way applies the whole composition, leaving conflict markers to resolve in place
// measure: does everything but touch the main trees, so a held agent's card stays current while its delta waits
export const LandModeSchema = z.enum(["check", "merge", "measure"]);
export type LandMode = z.infer<typeof LandModeSchema>;
// outstanding: only what hasn't landed yet, from the last landed tip (the default; what a second land applies)
// cumulative: the agent's whole output from where its branch left main; what the review lists and what "Land again"
// applies. Not a double application: it's the way back when landed work was discarded from the tree, since paths
// already there drop out per file.
export const AgentSpanSchema = z.enum(["cumulative", "outstanding"]);
export type AgentSpan = z.infer<typeof AgentSpanSchema>;
// Overrides the guard against landing mid-turn; safe since a land arrives as uncommitted changes the user reviews, and
// the rest of the turn lands on top of it later. Doesn't apply to a turn parked on a question, which needs no override
// at all.
export const AgentLandSchema = z.object({
    includeDocuments: z.boolean().optional().describe("Include recorded result documents, even when ignored or classified as scratch."),
    id: z.string().min(1).describe("Which conversation's work to merge."),
    mode: LandModeSchema.optional().describe(
        "How to apply it. The default applies every repository or none, so a refusal leaves the workspace exactly as it was. The other carries the whole composition and leaves conflicted paths with markers to resolve by hand.",
    ),
    span: AgentSpanSchema.optional().describe("How much of the work to take. Leave it out for everything not yet merged."),
    force: z.boolean().optional().describe("Go ahead despite a check that would otherwise refuse."),
});
