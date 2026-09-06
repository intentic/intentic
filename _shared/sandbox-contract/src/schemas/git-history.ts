// git history graph (the "Git Graph" view over a repo's real commits)
import { z } from "zod";
import { GitChangeSchema } from "./git.js";
import { RefNameSchema } from "./internal.js";
import { RepoParamSchema } from "./shared.js";
// A hex sha (full or git-abbreviated): the only shape the graph ever sends back, so the per-commit routes
// constrain to it rather than accepting an arbitrary git revision expression.
const ShaSchema = z.string().regex(/^[0-9a-f]{4,64}$/);
// One commit in the graph. `parents` (0 = root, 1 = normal, 2+ = merge) drive the lane layout, computed
// client-side. `refs` are the branch/tag decorations at this commit (tags keep their `tag: ` prefix; the bare
// "HEAD" marker is lifted into `head` instead). `at` is author time in ms since epoch; `short` is git's
// abbreviated sha; `body` is the message minus its subject line.
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
// One repo's log: commits newest-first across ALL refs (branch topology is the point of a graph), plus the
// checked-out branch (absent on a detached HEAD or an unborn repo).
export const GitLogSchema = z.object({
    repo: z.string().describe("Which repository."),
    branch: z.string().optional().describe("Which branch these are from."),
    commits: z.array(GitCommitSchema).describe("The commits, newest first."),
    // Whether a further page exists behind this one. The daemon learns it by asking git for one commit more than
    // it returns, see commitLog. It is also what stops the oldest row of a page from being drawn as a ROOT
    // commit, which is how a truncated history used to claim it began where the page happened to stop.
    hasMore: z
        .boolean()
        .describe(
            "There are older ones behind this page. It is also what stops the last row being drawn as the beginning of history, which is how a truncated log used to claim it started where the page happened to stop.",
        ),
});
export type GitLog = z.infer<typeof GitLogSchema>;
export const GitLogQuerySchema = RepoParamSchema.extend({
    limit: z.coerce.number().int().positive().max(2000).optional().describe("How many commits to return."),
    // How many newer commits to step over, the page cursor. Paged rather than one big read because a large
    // repository's log is tens of thousands of rows, and every one of them costs a zod validation, a wire
    // payload and a lane computation before anything is drawn.
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
// Every real git repo under /work as root-relative dir ids ("root" is implicit, the /work repo itself).
export const GitReposSchema = z.object({
    repos: z.array(z.string()).describe('Every repository\'s id. The workspace itself is always present as "root".'),
});
export type GitRepos = z.infer<typeof GitReposSchema>;
/* WHERE EACH WORKSPACE REPO LIVES ONLINE, one entry per repo that has a parseable remote, as the host and the
 * `owner/name` project it names. Separate from `repos` above rather than folded into it because that route is
 * on the file tree's hot path and this costs a `git remote -v` per repo; a caller that wants to recognise a
 * workspace repo in somebody else's list (the publisher claim does exactly that) asks for it deliberately.
 *
 * A repo with no remote, or one naming a local path, is absent rather than present-and-empty: "this repo is
 * nowhere online" and "this repo is at X" are different answers and only one of them can be matched against. */
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
/* PUT ONE FILE ON THE DEFAULT BRANCH AND PUBLISH IT, write, commit that path alone, push, in one call.
 *
 * One route rather than three because the interesting states are the ones BETWEEN the steps: a file written but
 * not committed, or committed but not pushed, is a repo the user now has to clean up by hand, and a browser
 * making three requests owns that mess without being able to describe it. Here the caller gets one answer that
 * says how far it got.
 *
 * `message` is the caller's because the commit shows up in the user's own history and a generic subject there
 * is litter. */
export const GitPublishFileSchema = RepoParamSchema.extend({
    path: z.string().min(1).describe("Which file, relative to the repository."),
    content: z.string().describe("Its whole new contents."),
    message: z.string().min(1).describe("The commit message."),
});
/* HOW FAR THE PUBLISH GOT, in the terms the screen has to explain it in. `ok` is "the file is on the default
 * branch of the remote" and nothing less, the only state that makes a public read of it succeed.
 *
 * The three steps are reported SEPARATELY because every boundary between them is a state a user can be left
 * in and would otherwise have to discover: a file written but not committed, a commit that exists locally but
 * was refused by the remote for credentials. Each of those needs a different sentence and a different next
 * move, and one `ok: false` cannot carry either. It is also what tells the daemon whether the worktree moved
 * at all, which decides whether this counts as a user write on the timeline.
 *
 * `branch` and `defaultBranch` ride along so a refusal can name both sides of the mismatch rather than saying
 * "wrong branch" at someone who cannot see which one they are on. */
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
// A commit's changed files (vs its first parent; a root commit vs the empty tree), the graph's detail tree
// renders these (line stats included) and reuses the diff UI on click. Just GitChanges: the line stats live on
// GitChange now, so working-tree and commit files share one shape.
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
// Git write actions from the graph's commit context menu (VSCode "Git Graph" parity). Non-destructive: branch
// and tag just add a ref (HEAD + worktree untouched, no checkpoint). Sequence ops (revert / cherry-pick /
// merge / rebase / drop) add or replay commits and are auto-checkpointed daemon-side; a conflict aborts and
// reports `ok:false` (an expected outcome, not a throw). Checkout and reset move HEAD (reset --hard discards
// the worktree), also auto-checkpointed. A `{repo, sha}` names the target commit for every commit-scoped
// action; a ref name (branch/tag) is validated structurally, git enforces the rest of ref-name legality
// (RefNameSchema is declared above, with the branch schemas that first use it).
export const GitBranchCreateSchema = RepoParamSchema.extend({
    sha: ShaSchema.describe("Which commit to start it at."),
    name: RefNameSchema.describe("The new branch's name."),
});
export const GitTagCreateSchema = RepoParamSchema.extend({
    sha: ShaSchema.describe("Which commit to tag."),
    name: RefNameSchema.describe("The tag's name."),
});
export const GitCheckoutSchema = RepoParamSchema.extend({ ref: RefNameSchema.describe("Where to switch to: a branch, a tag, or a commit.") });
// Deleting a tag locally, and, when a remote is named, on that remote too. The remote half is best-effort: a
// tag that was never pushed must not make deleting the local one report a failure.
export const GitTagDeleteSchema = RepoParamSchema.extend({
    name: RefNameSchema.describe("Which tag."),
    remote: RefNameSchema.optional().describe("Also delete it there. Leave it out to remove it locally only."),
});
// Publishing ONE tag, named explicitly so it never drags every other unpushed tag along with it.
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
/* THE STASH, work set aside without committing it, and the one part of a repository's real state the workspace
 * used to be blind to entirely. A `git stash` in a terminal made the agent's (or the user's) work vanish from
 * every surface here.
 *
 * An entry IS a commit: it has a sha, a time, a diff, and parents (HEAD when it was taken, the index, and the
 * untracked tree when `-u` was used). What it does not have is a place in any branch's ancestry, so the graph
 * hangs it off the commit it was taken on rather than flowing it down a lane.
 *
 * `ref` (`stash@{0}`) is the handle every verb takes, and it is POSITIONAL, dropping one renumbers the rest, so
 * a caller must re-read the list after any mutation rather than holding an index across it. */
export const StashEntrySchema = z.object({
    ref: z.string().describe("How to address it, which applying and dropping take."),
    sha: z.string().describe("The commit behind it, because a stash entry is a commit."),
    short: z.string().describe("The abbreviated form, for showing."),
    // git's own `WIP on <branch>: …` scaffolding stripped, leaving what a reader would call the message.
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
// A stash ref as git numbers them. Constrained rather than free text because it reaches a shell argument.
const StashRefSchema = z.string().regex(/^stash@\{\d{1,4}\}$/);
export const StashPushSchema = RepoParamSchema.extend({
    message: z.string().max(500).optional().describe("What to call it, so you know what it was later."),
    includeUntracked: z.boolean().optional().describe("Also set aside files git is not yet tracking, which are otherwise left where they are."),
});
// `pop` drops the entry on a clean apply; `apply` keeps it. Git's own distinction, and both are things people
// mean: pop is "resume this", apply is "try this here too".
export const StashApplySchema = RepoParamSchema.extend({
    ref: StashRefSchema.describe("Which entry."),
    pop: z.boolean().optional().describe("Remove it from the stash once it has been applied cleanly."),
});
export const StashRefParamSchema = RepoParamSchema.extend({ ref: StashRefSchema.describe("Which entry.") });
export const StashDiffQuerySchema = RepoParamSchema.extend({ ref: StashRefSchema.describe("Which entry.") });
/* THE LAST THING THAT MOVED THIS BRANCH, and whether it can be walked back.
 *
 * Complements the Checkpoints timeline rather than duplicating it: a checkpoint restores the WORKING TREE, this
 * moves the BRANCH. After a bad rebase the files are often already right and only the ref is wrong, and
 * restoring a whole worktree snapshot to fix that would drag every unrelated edit since back with it.
 *
 * `description` is git's own reflog subject, so the button can name what it will undo in git's words rather than
 * a guess. `previousSha` is where the branch returns to, and it doubles as the CONCURRENCY TOKEN: the undo is
 * refused when the repository has moved since this was read, so an undo prepared against a stale view cannot
 * land somewhere the user never looked at. Absent = nothing to undo (a fresh branch, a detached HEAD, or a
 * halted operation, which ends by aborting rather than by moving the branch). */
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
    // The action rewrote FILES as well as the ref, so undoing it faithfully needs a hard reset. The UI uses this
    // to decide whether it has to warn about losing work.
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
// `previousSha` is the position the caller was shown; `discardChanges` picks a hard reset over a soft one.
export const GitUndoSchema = RepoParamSchema.extend({
    previousSha: ShaSchema.describe(
        "Where to go back to, from the matching read. It is also proof you looked: one prepared against a stale view is refused.",
    ),
    discardChanges: z.boolean().optional().describe("Also rewrite the files, rather than only moving the branch."),
});
