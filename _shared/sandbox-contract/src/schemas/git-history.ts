// The Git Graph view over a repo's real commits.
import { z } from "zod";
import { GitChangeSchema } from "./git.js";
import { RefNameSchema } from "./internal.js";
import { RepoParamSchema } from "./shared.js";
// A hex sha, full or abbreviated; commit routes accept only this, never an arbitrary git revision expression.
const ShaSchema = z.string().regex(/^[0-9a-f]{4,64}$/);
// One commit in the graph. `parents` drives lane layout, computed client-side; `refs` keeps tags' `tag: ` prefix but
// lifts a bare HEAD marker into `head` instead.
export const GitCommitSchema = z.object({
    sha: z.string().describe("The commit, in full."),
    short: z.string().describe("The abbreviated form, for showing."),
    parents: z
        .array(z.string())
        .describe(
            "What it came from. None means the first commit, one is ordinary, two or more is a merge, which is what a graph draws its lanes from.",
        ),
    subject: z.string().describe("Its first line."),
    body: z.string().describe("Everything after that."),
    author: z.string().describe("Who wrote it."),
    email: z.string().describe("Their address."),
    at: z.number().describe("When they wrote it, in milliseconds."),
    refs: z.array(z.string()).describe("Branches and tags sitting on it."),
    head: z.boolean().describe("Whether this is where the repository currently stands."),
});
export type GitCommit = z.infer<typeof GitCommitSchema>;
// One repo's log: commits newest-first across all refs, not just the checked-out branch, since branch topology is the
// point of a graph.
export const GitLogSchema = z.object({
    repo: z.string().describe("Which repository."),
    branch: z.string().optional().describe("Which branch these are from."),
    commits: z.array(GitCommitSchema).describe("The commits, newest first."),
    // Whether older commits remain behind this page; also stops the last row from being drawn as history's root.
    hasMore: z
        .boolean()
        .describe(
            "There are older ones behind this page. It is also what stops the last row being drawn as the beginning of history, which is how a truncated log used to claim it started where the page happened to stop.",
        ),
});
export type GitLog = z.infer<typeof GitLogSchema>;
export const GitLogQuerySchema = RepoParamSchema.extend({
    limit: z.coerce.number().int().positive().max(2000).optional().describe("How many commits to return."),
    // Page cursor: how many newer commits to skip before returning results.
    skip: z.coerce
        .number()
        .int()
        .nonnegative()
        .max(1_000_000)
        .optional()
        .describe(
            "How many newer commits to step over, which is how you page further back. Paged rather than read whole, because a large repository's history is tens of thousands of rows.",
        ),
});
// Every real git repo under /work, as root-relative dir ids; "root" is the /work repo itself, implicit as an id.
export const GitReposSchema = z.object({
    repos: z.array(z.string()).describe('Every repository\'s id. The workspace itself is always present as "root".'),
});
export type GitRepos = z.infer<typeof GitReposSchema>;
// One entry per workspace repo with a parseable remote, as host and owner/name. Absent, not present-and-empty, when
// there's no remote or it points at a local path.
export const GitRemoteRepoSchema = z.object({
    repo: z.string().describe("The workspace repository."),
    host: z.string().describe("Which forge its remote points at."),
    project: z.string().describe("Which project there, as owner and name."),
});
export type GitRemoteRepo = z.infer<typeof GitRemoteRepoSchema>;
export const GitRemoteReposSchema = z.object({
    repos: z.array(GitRemoteRepoSchema).describe("Each repository matched to the project its remote points at."),
});
export type GitRemoteRepos = z.infer<typeof GitRemoteReposSchema>;
// Writes one file to the default branch and publishes it: write, commit that path alone, push, in one call. `message`
// is the caller's, since it lands in the user's own commit history.
export const GitPublishFileSchema = RepoParamSchema.extend({
    path: z.string().min(1).describe("Which file, relative to the repository."),
    content: z.string().describe("Its whole new contents."),
    message: z.string().min(1).describe("The commit message."),
});
// `ok` is true only once the file is live on the default branch of the remote. `wrote`/`committed`/`pushed` mark each
// step separately, and `branch`/`defaultBranch` name a wrong-branch mismatch.
export const GitPublishFileResultSchema = z.object({
    ok: z.boolean().describe("Whether the whole thing went through."),
    wrote: z.boolean().describe("The file was written."),
    committed: z.boolean().describe("The commit was recorded."),
    pushed: z.boolean().describe("It reached the remote."),
    branch: z.string().optional().describe("Which branch it happened on."),
    defaultBranch: z.string().optional().describe("Which branch the repository considers its main one, so a caller can see it was on a side branch."),
    reason: z
        .string()
        .optional()
        .describe(
            "Why it stopped where it did. Being on a side branch, having no remote and having no credentials are all reported here rather than raised.",
        ),
});
export type GitPublishFileResult = z.infer<typeof GitPublishFileResultSchema>;
export const GitCommitDiffQuerySchema = RepoParamSchema.extend({ sha: ShaSchema.describe("Which commit.") });
// A commit's changed files, diffed against its first parent (a root commit against the empty tree); reuses `GitChange`
// so working-tree and commit diffs share one shape.
export const GitCommitDiffSchema = z.object({
    files: z
        .array(GitChangeSchema)
        .describe(
            "Which files it touched, with counts but not contents. Fetch any one file's contents separately, so a commit with a thousand files stays one cheap answer.",
        ),
});
export type GitCommitDiff = z.infer<typeof GitCommitDiffSchema>;
export const GitCommitFileDiffQuerySchema = RepoParamSchema.extend({
    sha: ShaSchema.describe("Which commit."),
    path: z.string().min(1).describe("Which file in it."),
});
// Git write actions from the graph's context menu. Branch/tag only add a ref (no checkpoint); sequence ops, checkout,
// and reset are auto-checkpointed, and a conflict returns `ok:false` instead of throwing.
export const GitBranchCreateSchema = RepoParamSchema.extend({
    sha: ShaSchema.describe("Which commit to start it at."),
    name: RefNameSchema.describe("The new branch's name."),
});
export const GitTagCreateSchema = RepoParamSchema.extend({
    sha: ShaSchema.describe("Which commit to tag."),
    name: RefNameSchema.describe("The tag's name."),
});
export const GitCheckoutSchema = RepoParamSchema.extend({ ref: RefNameSchema.describe("Where to switch to: a branch, a tag, or a commit.") });
// Deletes a tag locally, and on the named remote too; a tag never pushed there does not fail the local delete.
export const GitTagDeleteSchema = RepoParamSchema.extend({
    name: RefNameSchema.describe("Which tag."),
    remote: RefNameSchema.optional().describe("Also delete it there. Leave it out to remove it locally only."),
});
// Pushes only the named tag, never every unpushed tag.
export const GitTagPushSchema = RepoParamSchema.extend({
    name: RefNameSchema.describe("Which tag."),
    remote: RefNameSchema.describe("Which remote to send it to."),
});
export const GitResetSchema = RepoParamSchema.extend({
    sha: ShaSchema.describe("Which commit to move the branch to."),
    mode: z
        .enum(["soft", "mixed", "hard"])
        .describe(
            "How much to take with it: move the branch alone, also unstage, or also throw away what is on disk. The last one takes a checkpoint first.",
        ),
});
export const GitCommitActionSchema = RepoParamSchema.extend({ sha: ShaSchema.describe("Which commit to act on.") });
export const GitActionResultSchema = z.object({
    ok: z.boolean().describe("Whether it worked."),
    reason: z
        .string()
        .optional()
        .describe(
            "Why not, in git's own words. A conflict, a missing remote and missing credentials are all reported here rather than raised, because they are things a screen has to render rather than breakages.",
        ),
});
export type GitActionResult = z.infer<typeof GitActionResultSchema>;
// A stash entry is a commit (sha, time, diff, parents) with no place in any branch's ancestry. `ref` (`stash@{0}`) is
// positional: dropping one renumbers the rest, so re-read the list after any mutation.
export const StashEntrySchema = z.object({
    ref: z.string().describe("How to address it, which applying and dropping take."),
    sha: z.string().describe("The commit behind it, because a stash entry is a commit."),
    short: z.string().describe("The abbreviated form, for showing."),
    // Git's `WIP on <branch>: ` prefix is stripped from the raw stash message.
    subject: z.string().describe("What it was set aside as, with git's own scaffolding stripped off."),
    branch: z.string().optional().describe("Which branch it was set aside from."),
    at: z.number().describe("When, in milliseconds."),
    parents: z.array(z.string()).describe("What it sits on, so a graph can draw it like any other commit."),
});
export type StashEntry = z.infer<typeof StashEntrySchema>;
export const StashListSchema = z.object({
    repo: z.string().describe("Which repository."),
    stashes: z.array(StashEntrySchema).describe("What is set aside, newest first."),
});
// A stash ref as git numbers it (`stash@{0}`); constrained because it reaches a shell argument.
const StashRefSchema = z.string().regex(/^stash@\{\d{1,4}\}$/);
export const StashPushSchema = RepoParamSchema.extend({
    message: z.string().max(500).optional().describe("What to call it, so you know what it was later."),
    includeUntracked: z.boolean().optional().describe("Also set aside files git is not yet tracking, which are otherwise left where they are."),
});
// `pop` drops the entry after a clean apply; `apply` keeps it, git's own resume-vs-try-again distinction.
export const StashApplySchema = RepoParamSchema.extend({
    ref: StashRefSchema.describe("Which entry."),
    pop: z.boolean().optional().describe("Remove it from the stash once it has been applied cleanly."),
});
export const StashRefParamSchema = RepoParamSchema.extend({ ref: StashRefSchema.describe("Which entry.") });
export const StashDiffQuerySchema = RepoParamSchema.extend({ ref: StashRefSchema.describe("Which entry.") });
// The last ref move on this branch, and whether it can be undone; complements Checkpoints, which restores the working
// tree instead. `previousSha` doubles as a concurrency token: refused if the branch moved since it was read.
export const UndoKindSchema = z.enum(["commit", "amend", "merge", "rebase", "cherry-pick", "revert", "reset", "pull", "other"]);
export type UndoKind = z.infer<typeof UndoKindSchema>;
export const UndoableActionSchema = z.object({
    kind: UndoKindSchema.describe("What the last action was."),
    description: z.string().describe("What undoing it would do, in words."),
    branch: z.string().describe("Which branch would move."),
    sha: z.string().describe("Where it stands now."),
    previousSha: z
        .string()
        .describe(
            "Where it would go back to. Send this with the undo as proof you looked, so one prepared against a view that has since moved is refused rather than landing somewhere unexamined.",
        ),
    // True when undoing needs a hard reset, not just a ref move.
    changesWorkingTree: z
        .boolean()
        .describe("Undoing would rewrite files as well as moving the branch, so anything offering it should warn about losing work."),
});
export type UndoableAction = z.infer<typeof UndoableActionSchema>;
export const GitUndoStateSchema = z.object({
    repo: z.string().describe("Which repository."),
    action: UndoableActionSchema.optional().describe("What undoing would reverse. Absent means there is nothing to go back from."),
});
export type GitUndoState = z.infer<typeof GitUndoStateSchema>;
// `previousSha` must match what the caller was shown; `discardChanges` picks a hard reset over a soft one.
export const GitUndoSchema = RepoParamSchema.extend({
    previousSha: ShaSchema.describe(
        "Where to go back to, from the matching read. It is also proof you looked: one prepared against a stale view is refused.",
    ),
    discardChanges: z.boolean().optional().describe("Also rewrite the files, rather than only moving the branch."),
});
