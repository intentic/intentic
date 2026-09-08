import { z } from "zod";
import { AgentProviderSchema } from "./agent.js";
import { LandConflictSchema, LandedMessageSchema } from "./agents.js";
import { CommandRunSchema } from "./ci.js";
import { RefNameSchema } from "./internal.js";
import { RepoParamSchema } from "./shared.js";

// Which of the working tree's diffs a row is about; a path can be both staged and edited again, so a side is never
// defaulted.
// staged: index vs HEAD.
// unstaged: worktree vs index (untracked ⇒ no before side).
// conflicted: HEAD vs worktree, markers included (no stage 0 to diff against).
export const GitDiffSideSchema = z.enum(["staged", "unstaged", "conflicted"]);
export type GitDiffSide = z.infer<typeof GitDiffSideSchema>;

// What a bulk git action applies to, never simply a list of paths (unbounded, unlike a review's rows).
// paths: exactly these, from a list a browser already drew.
// scope: a description the daemon resolves against live status, so nothing here can be stale.
// neither: the whole repository.
export const GitScopeSchema = z.object({
    side: GitDiffSideSchema.optional().describe(
        "Narrow to one of the three lists a repository's changes split into. Leave it out for all of them, which is the whole repository.",
    ),
    // Same attribution as `RepoChanges.origins`; a path list would miss files beyond what's on screen.
    origin: z
        .string()
        .min(1)
        .optional()
        .describe("Narrow to the files one conversation landed. Leave it out for everyone's, including your own edits."),
});
export type GitScope = z.infer<typeof GitScopeSchema>;

// Wire bound on an explicit path list, not a git/argv limit; past a few hundred rows, name a scope instead.
export const MAX_ACTION_PATHS = 1000;

const ActionPathsSchema = z
    .array(z.string().min(1))
    .max(MAX_ACTION_PATHS)
    .describe("Exactly these repository-relative paths. For anything bigger than a hand-picked selection, describe a scope instead.");

// Two optional fields rather than a union: `{}` (the whole repository) is a meaningful value a discriminated union
// cannot spell.
export const GitTargetSchema = z.object({
    paths: ActionPathsSchema.optional(),
    scope: GitScopeSchema.optional().describe(
        "What to act on, described rather than listed, so it covers every matching file in the repository and not just the ones a list could hold.",
    ),
});
export type GitTarget = z.infer<typeof GitTargetSchema>;

// Both together is refused: silently preferring one would make the other a lie.
const ONE_TARGET = { message: "name paths or a scope, not both" } as const;
const oneTarget = (target: GitTarget): boolean => target.paths === undefined || target.scope === undefined;

// What a commit records; the index already does path selection, so `stage` only says what to add first.
// absent: commit whatever is already staged.
// {}: stage everything, then commit.
// { scope }: stage what the scope names, then commit.
// { paths }: stage exactly those paths, then commit.
// Never `commit --only`: a partial commit over a half-staged file would record the worktree while the row showed the
// index.
export const CommitSchema = RepoParamSchema.extend({
    message: z.string().min(1).describe("The commit message."),
    stage: GitTargetSchema.refine(oneTarget, ONE_TARGET)
        .optional()
        .describe(
            "What to stage before committing. Leave it out to record the index exactly as it stands; give it an empty object to stage everything first.",
        ),
});
export const DiscardSchema = RepoParamSchema.extend(GitTargetSchema.shape)
    .describe("What to throw away. Neither paths nor a scope discards every uncommitted change in the repository.")
    .refine(oneTarget, ONE_TARGET);
// Index-only moves; nothing on disk changes, so neither needs a checkpoint. An empty target means the whole repository
// (`git add -A`, or the entire index).
export const GitIndexMoveSchema = RepoParamSchema.extend(GitTargetSchema.shape)
    .describe("What to move across the index. Nothing on disk changes either way.")
    .refine(oneTarget, ONE_TARGET);
// No separate "set upstream" flag: the daemon runs `push -u` exactly when the branch has none yet, which is never
// destructive.
export const PushSchema = RepoParamSchema.extend({
    branch: z
        .string()
        .min(1)
        .optional()
        .describe("Which branch to push. Leave it out for the checked-out one. A branch with no upstream yet gets one set on this push."),
});
// Who said no to a push, read off git's own words (`pushRefusal`); the three answers ask three different things of the
// owner.
// hook: this repo's own pre-push hook refused it; the code is known wrong, worth a fix.
// remote: the server rejected the refs (non-fast-forward, protected branch); pull first or push elsewhere.
// transport: it never got there (credentials, unreachable host); a retry is the only useful button.
export const PushRefusalSchema = z.enum(["hook", "remote", "transport"]);
export type PushRefusal = z.infer<typeof PushRefusalSchema>;
// A push runs this repo's pre-push hook (minutes of output); it streams like `CommandRunSchema`, never held open on the
// request, since the browser's header deadline is seconds.
export const PushRunSchema = CommandRunSchema.extend({
    repo: z.string().describe("The repository this run is about, the same id the routes take."),
    reason: z
        .string()
        .optional()
        .describe("Why not, in git's own words: the last verdict line, for a row that has room for one line. The whole tail is `output`."),
    refusedBy: PushRefusalSchema.optional().describe(
        "Who refused a failed push: this repository's pre-push hook (the code is wrong, a fix is worth proposing), the remote (pull first), or the transport (credentials, network: retry). Absent while it runs and for a push that went.",
    ),
});
export type PushRun = z.infer<typeof PushRunSchema>;
export const GitFileQuerySchema = RepoParamSchema.extend({ path: z.string().min(1).describe("The file to read, relative to the repository root.") });
export const GitFileWriteSchema = RepoParamSchema.extend({
    path: z.string().min(1).describe("Where to write, relative to the repository root. Missing folders are created."),
    content: z.string().describe("The file's whole new contents."),
});
export const GitFileDiffQuerySchema = RepoParamSchema.extend({
    path: z.string().min(1).describe("The file, relative to the repository root."),
    side: GitDiffSideSchema.describe(
        "Which comparison you want. A file that is staged and then edited again has genuinely different answers for each, which is why this is required rather than assumed.",
    ),
});
export const GitStatusSchema = z.object({
    branch: z.string().describe("The checked-out branch."),
    dirty: z.boolean().describe("Whether anything is uncommitted."),
    files: z.array(z.string()).describe("Every path with something pending, staged or not."),
});
export const GitFilesSchema = z.object({
    files: z.array(z.string()).describe("Every path git tracks, relative to the repository root. Ignored and untracked files are not here."),
});
export const GitFileSchema = z.object({
    path: z.string().describe("The path, as asked for."),
    content: z.string().describe("The file's contents as they stand on disk."),
});

// One repo's slice of a workspace-wide action: git cannot span repositories, so a caller fans out into one of these per
// repo.
export const RepoTargetSchema = z
    .object({ repo: z.string().min(1).describe("Which repository.") })
    .extend(GitTargetSchema.shape)
    .refine(oneTarget, ONE_TARGET);
export type RepoTarget = z.infer<typeof RepoTargetSchema>;
// One change to a file: an uncommitted working-tree change, an agent worktree's delta vs its base, or a file in a
// commit. `additions`/`deletions` are numstat counts, absent for binary or untracked files.
export const GitChangeSchema = z.object({
    // Forward slashes; for a rename this is the new path (`from` holds the old one).
    path: z.string().describe("The path, relative to the repository root. For a rename this is the new one."),
    // Git's unmerged state (`U`): stages 2/3 hold "ours"/"theirs", no stage 0 to commit.
    status: z
        .enum(["added", "modified", "deleted", "renamed", "type-changed", "conflicted"])
        .describe("What happened to it. Conflicted is not a kind of edit: nothing can be committed anywhere in the repository while one exists."),
    from: z.string().optional().describe("Where a renamed file came from."),
    additions: z
        .number()
        .optional()
        .describe("Lines added. Absent for a binary file, and for an untracked one, which has nothing to compare against."),
    deletions: z.number().optional().describe("Lines removed. Absent for the same reasons additions is."),
    // Precomputed once and shipped with the list, so a row's number never changes under the reader as it renders.
    code: z
        .object({ additions: z.number(), deletions: z.number() })
        .optional()
        .describe(
            "The same +/− with every comment stripped from both sides, which is what a review shows beside a diff that opens on code alone. Absent when the file cannot be read that way (binary, too large, or a language this build ships no grammar for): git's own counts above are then the reading.",
        ),
});
export type GitChange = z.infer<typeof GitChangeSchema>;
// Where the checked-out branch stands against its remote; every field can legitimately be absent (no remote, unpushed
// branch, detached HEAD). `behind` is only as fresh as the last fetch.
export const GitRemoteStateSchema = z.object({
    remote: z
        .string()
        .optional()
        .describe(
            "The remote this branch pushes to. Absent means none is configured. In a fork with two remotes, pushing to the wrong one succeeds and leaves the count stuck, which is why this says which.",
        ),
    branch: z.string().optional().describe("The checked-out branch. Absent when the repository is on a bare commit, or has no commits yet."),
    // Full ref, e.g. "origin/main".
    upstream: z.string().optional().describe("The branch on the remote this one follows. Absent means the next push will publish it."),
    ahead: z.number().describe("Commits you have that the remote does not."),
    behind: z.number().describe("Commits the remote has that you do not, as of the last fetch. Fetch before trusting it."),
});
export type GitRemoteState = z.infer<typeof GitRemoteStateSchema>;
// One local branch, for the switcher.
export const GitBranchSchema = z.object({
    name: z.string().describe("The branch name."),
    current: z.boolean().describe("Whether this is the one checked out."),
    upstream: z.string().optional().describe("The branch on the remote it follows, if any."),
    ahead: z.number().describe("Commits this branch has that its remote counterpart does not."),
    behind: z.number().describe("Commits its remote counterpart has that it does not."),
    // Distinct from no upstream: the configured one existed and was deleted remotely.
    gone: z
        .boolean()
        .optional()
        .describe(
            "The branch it followed no longer exists on the remote, usually because a merged pull request deleted it. The signal that this one is safe to delete.",
        ),
    at: z.number().describe("When its tip was committed, in milliseconds. Lists are newest first."),
});
export type GitBranch = z.infer<typeof GitBranchSchema>;
// A remote-tracking branch, not GitBranch with optionals: it has no upstream/ahead/behind of its own, and zeros there
// would look like a synced local branch. `remote`/`branch` are `name` pre-split for grouping.
export const GitRemoteBranchSchema = z.object({
    name: z.string().describe("The full name, such as origin/main."),
    remote: z.string().describe("Just the remote part, so a picker can group by it without re-parsing."),
    branch: z.string().describe("Just the branch part."),
    at: z.number().describe("When its tip was committed, in milliseconds, as this repository last saw it."),
});
export type GitRemoteBranch = z.infer<typeof GitRemoteBranchSchema>;
// Locals and remote-tracking branches together, so the switcher never draws a half-populated list from two round trips.
export const GitBranchesSchema = z.object({
    branches: z.array(GitBranchSchema).describe("Branches in this repository."),
    remotes: z
        .array(GitRemoteBranchSchema)
        .describe("Branches on its remotes, as last seen. Sent together with the locals so a switcher never draws a half-filled list."),
});
// Creates at `start` (sha or ref; absent means HEAD); `checkout` switches to it immediately.
export const GitBranchCreateAtSchema = RepoParamSchema.extend({
    name: RefNameSchema.describe("The new branch's name."),
    start: z.string().min(1).optional().describe("Where to start it: a commit or another branch. Leave it out to start from where you are."),
    checkout: z.boolean().optional().describe("Switch to it as well as creating it."),
});
// `force` is the deliberate retry after git refuses to drop an unmerged branch.
export const GitBranchDeleteSchema = RepoParamSchema.extend({
    name: RefNameSchema.describe("The branch to delete."),
    force: z
        .boolean()
        .optional()
        .describe("Delete it even though it holds work that was never merged. The deliberate retry after the first attempt refuses."),
});
// A merge/rebase/cherry-pick/revert left stopped on a conflict, never finished or aborted; the daemon's own verbs
// always abort cleanly, so this is only ever something a person or agent left behind in a terminal.
export const GitOperationSchema = z.enum(["merge", "rebase", "cherry-pick", "revert"]);
export type GitOperation = z.infer<typeof GitOperationSchema>;
export const GitOperationStateSchema = z.object({
    repo: z.string().describe("The repository asked about."),
    operation: GitOperationSchema.optional().describe(
        "Which operation the working tree is stuck inside. Absent means it is not stuck at all, which is almost always. While one is present git refuses nearly everything else, and abandoning it is the only way out.",
    ),
});
export type GitOperationState = z.infer<typeof GitOperationStateSchema>;
export const RepoChangesSchema = z.object({
    // The {repo} param the per-repo git routes accept: "root" or a repo id (its root-relative dir).
    repo: z.string(),
    // Absent on an unborn HEAD (initialized, never committed).
    branch: z.string().optional().describe("The checked-out branch. Absent in a repository that has no commits yet."),
    // Staging a conflicted path (`git add`) is how you tell git it is resolved.
    conflicted: z
        .array(GitChangeSchema)
        .describe(
            "Paths a merge or rebase could not finish. First, because nothing anywhere in this repository can be committed until they are resolved. Held apart from the two lists below, because staged or not is not a question one of these has an answer to.",
        ),
    // Absent means not mid-anything, the case for almost every repo.
    operation: GitOperationSchema.optional().describe(
        "What halted, when something did. This is the sentence that explains the conflicts above and names the way out of them.",
    ),
    // Kept apart because a path can appear on both with different statuses (the classic `MM`); each side's counts
    // describe only its own diff.
    staged: z.array(GitChangeSchema).describe("What a plain commit would record right now."),
    unstaged: z
        .array(GitChangeSchema)
        .describe(
            "Edits on disk that are not staged, plus untracked files. A path can be in both lists at once with different line counts, which is why they are separate.",
        ),
    // Per side, not one total: which side loses rows first is the daemon's own choice (staged outranks unstaged) and
    // cannot be derived from the lists, so it is stated.
    truncated: z
        .object({
            staged: z.number().describe("Staged changes not listed above."),
            unstaged: z.number().describe("Unstaged changes not listed above."),
        })
        .optional()
        .describe(
            "How many changes were cut from each of the two lists above. A freshly cloned monorepo or a mass delete runs to six figures, which no screen can draw, so past a budget the lists arrive short and this says by how much on each side. Absent means they are complete.",
        ),
    // 0 for `ahead`/`behind` with no remote or no upstream.
    remote: GitRemoteStateSchema.optional().describe("Where this repository stands against its remote."),
    // Keyed by path, not on each change, since one path can appear on two sides with the same origin. Ids only; look up
    // identity in `originAgents`.
    origins: z
        .record(z.string(), z.array(z.string()))
        .optional()
        .describe(
            "Which conversation put each path here, newest first, keyed by path. Only work that went through a merge can appear: edits made in the shared tree, in a terminal, or by a person are simply absent rather than guessed at.",
        ),
    error: z
        .string()
        .optional()
        .describe(
            "Why the repository could not be read at all, in git's own words. A repository left broken by a failed import arrives with empty lists and this set, rather than vanishing from the answer with nothing to act on.",
        ),
});
export type RepoChanges = z.infer<typeof RepoChangesSchema>;
// Display identity for an id in `origins`, carried here rather than looked up in the roster: the roster drops archived
// agents, but a landing outlives them. Read from the same pass as the attribution, so the two cannot disagree.
export const OriginAgentSchema = z.object({
    title: z.string().optional().describe("The conversation's title. Absent for one that never got as far as having a title."),
    provider: AgentProviderSchema.describe("Which model provider it ran on."),
    // Absent means nothing was written, or (see `landedMessageDraft` on the agent's card) it still is; never fall back
    // to guessing a title from the ask.
    landedMessage: LandedMessageSchema.optional().describe(
        "What the merged work did, drafted by the conversation itself. Carried here as well as on its card, because merged lines outlive the card: archiving a finished conversation does not uncommit its work.",
    ),
});
export type OriginAgent = z.infer<typeof OriginAgentSchema>;
// Aggregated review set across every repo (root + every discovered repo).
export const GitChangesSchema = z.object({
    repos: z
        .array(RepoChangesSchema)
        .describe(
            "One entry per repository that has something pending, is out of step with its remote, or could not be read. A clean repository is simply absent.",
        ),
    // An id can still be missing here (a retired retention-sweep entry); the panel keeps its id-shaped fallback rather
    // than reattributing to the user.
    originAgents: z
        .record(z.string(), OriginAgentSchema)
        .optional()
        .describe(
            "Who each conversation named above is, keyed by id, so a caller need not look them up. Absent when nothing in the review can be attributed.",
        ),
    // Sandbox-wide, not per-tab, so a reload or another device still knows a commit is running. Read at response time,
    // not from the memoized scan. Absent means nothing is committing.
    committing: z
        .array(z.string())
        .optional()
        .describe(
            "Repositories with a commit running right now. The sandbox's answer rather than any one tab's, so a reload, a second window and another device all know. Absent means nothing is committing.",
        ),
});
export type GitChanges = z.infer<typeof GitChangesSchema>;
// Re-read inside the same lock the commit used, so the caller redraws from here instead of a full rescan. `changes`
// absent follows the scan's own drop rule; merge `originAgents` over what you hold, don't replace it.
export const CommitResultSchema = z.object({
    committed: z.boolean().describe("Whether a commit was actually recorded."),
    changes: RepoChangesSchema.optional().describe(
        "What this repository looks like now, read in the same breath as the commit so a caller can redraw from here instead of asking for a fresh scan. Absent means there is nothing left to show.",
    ),
    originAgents: z
        .record(z.string(), OriginAgentSchema)
        .optional()
        .describe(
            "Who the conversations named in those changes are. Merge it over what you already hold rather than replacing: other repositories still name their own.",
        ),
});
export type CommitResult = z.infer<typeof CommitResultSchema>;
// Repo-relative dir + package name for grouping changed files; distinct from WorkspacePackage (the dependency graph's
// node), a filesystem fact, not a graph position.
export const WorkspaceModuleSchema = z.object({
    dir: z.string().describe("Where the package lives, relative to its repository. Empty when the repository is itself one package."),
    name: z.string().describe("The name the package declares for itself."),
});
export type WorkspaceModule = z.infer<typeof WorkspaceModuleSchema>;
export const RepoModulesSchema = z.object({
    repo: z.string().describe("Which repository."),
    modules: z.array(WorkspaceModuleSchema).describe("Its packages."),
});
export type RepoModules = z.infer<typeof RepoModulesSchema>;
export const WorkspaceModulesSchema = z.object({ repos: z.array(RepoModulesSchema).describe("Every repository with the packages inside it.") });
export type WorkspaceModules = z.infer<typeof WorkspaceModulesSchema>;
// One file an agent touched that still differs from main, plus whether main's working tree already holds it:
// in main's history: accepted, no longer a difference — no row (see `absorbed`).
// in main's tree, uncommitted: `landed: true`.
// neither (never landed, or landed then discarded): `landed: false` — what "Land now" applies to.
// A landed row stays until committed; that is the only act that retires it.
export const AgentChangeSchema = GitChangeSchema.extend({
    landed: z
        .boolean()
        .describe(
            "Whether your workspace already holds this content. Read from the tree at request time, not from what a land recorded: discard a landed file in the Changes panel and this goes back to false, which is what puts it back under Land now.",
        ),
});
export type AgentChange = z.infer<typeof AgentChangeSchema>;
// An agent worktree's delta vs its base, deliberately not RepoChanges: no index here, so sharing that shape would force
// an empty `staged` and a staging affordance that cannot work on a worktree nobody checks out.
export const AgentRepoChangesSchema = z.object({
    repo: z.string().describe("Which repository."),
    branch: z.string().optional().describe("The branch this conversation's work sits on."),
    changes: z.array(AgentChangeSchema).describe("What it changed there."),
    // Read from the same tree at the same instant as the rows it groups, so the two cannot disagree.
    modules: z
        .array(WorkspaceModuleSchema)
        .describe(
            "The packages of the tree these changes came from, so a review can group by package. Carried with the changes rather than looked up separately, because a package the conversation has just created exists only in its own copy and the shared tree has never heard of it.",
        ),
});
export type AgentRepoChanges = z.infer<typeof AgentRepoChangesSchema>;
// The review, plus why the last land refused: a conflict is found when the turn ends but resolved later on this
// surface, so it rides here rather than only in the land response, and refreshes on every land.
export const AgentChangesSchema = z.object({
    repos: z.array(AgentRepoChangesSchema).describe("One entry per repository the conversation touched."),
    // Disambiguates two opposite reasons for an empty list: nothing written, versus everything already committed.
    absorbed: z
        .number()
        .describe(
            "How many of this conversation's files your own history already carries, and which are therefore not listed as differences any more.",
        ),
    conflicts: z
        .array(LandConflictSchema)
        .optional()
        .describe(
            "Why the last merge refused, when one did. Carried here as well as in the merge's own answer, because a conflict is found the moment a turn ends and dealt with hours later on this surface, which would otherwise open with nothing to explain what it promised to resolve.",
        ),
});
export type AgentChanges = z.infer<typeof AgentChangesSchema>;

// Own read (a `git log` per repo), not folded into the review, whose rows are differences against main and these are
// not. A commit CARRIES the work without authoring it: a path is attributed to the newest commit that left it there.
export const AgentHistoryCommitSchema = z.object({
    sha: z.string().describe("The commit."),
    short: z.string().describe("Its abbreviated hash, which is what a reader recognises it by."),
    subject: z.string().describe("Its first line."),
    author: z.string().describe("Who committed it."),
    at: z.number().describe("When it was authored, in milliseconds."),
    changes: z
        .array(GitChangeSchema)
        .describe(
            "The conversation's files that this commit is the newest carrier of, as the conversation changed them. Every file appears under exactly one commit, so these counts add up to the work rather than over-counting a file that history touched twice.",
        ),
});
export type AgentHistoryCommit = z.infer<typeof AgentHistoryCommitSchema>;
export const AgentRepoHistorySchema = z.object({
    repo: z.string().describe("Which repository."),
    commits: z.array(AgentHistoryCommitSchema).describe("The commits carrying this conversation's work there, newest first."),
    // Same reason as the review's rows: a new package lives only in its own copy and is otherwise ungroupable.
    modules: z.array(WorkspaceModuleSchema).describe("The packages of the tree these files came from, so a review can group them by package."),
});
export type AgentRepoHistory = z.infer<typeof AgentRepoHistorySchema>;
export const AgentHistorySchema = z.object({
    repos: z.array(AgentRepoHistorySchema).describe("One entry per repository holding committed work of this conversation."),
    unaccounted: z
        .number()
        .describe(
            "How many of the conversation's absorbed files none of these commits carries. Above zero means its content reached your main line by some other road, so the commits listed are not the whole story.",
        ),
});
export type AgentHistory = z.infer<typeof AgentHistorySchema>;
