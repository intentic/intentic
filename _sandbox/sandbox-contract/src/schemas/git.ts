import { z } from "zod";
import { AgentProviderSchema } from "./agent.js";
import { LandConflictSchema, LandedMessageSchema } from "./agents.js";
import { RefNameSchema } from "./internal.js";
import { RepoParamSchema } from "./shared.js";
// What a commit records, three shapes, each a real git spelling. The last two are for the case where nothing
// is staged yet and the caller has said what to stage; they are alternatives, and a caller sends at most one:
//   absent      ⇒ commit whatever is staged (plain `git commit`)
//   all: true   ⇒ stage every change in the repo, then commit (`commit -a`; VSCode's "stage all and commit")
//   paths       ⇒ `git add` those repo-relative paths, then commit the index
//
// `paths` is emphatically NOT `commit --only`. The index IS git's mechanism for choosing what a commit
// contains, so a second path-selection channel alongside it could only disagree with it: a partial commit over
// a half-staged file records the WORKTREE content while the row the user picked showed the INDEX content. This
// stages and then records the whole index, which is why it is safe, and why it also survives a merge, where
// git refuses a partial commit outright (and refuses it only AFTER moving the index).
export const CommitSchema = RepoParamSchema.extend({
    message: z.string().min(1).describe("The commit message."),
    all: z
        .boolean()
        .optional()
        .describe("Stage every change in the repository first, then commit. An alternative to naming paths, not a companion to it."),
    paths: z
        .array(z.string().min(1))
        .max(500)
        .optional()
        .describe("Stage exactly these paths, then commit everything staged. Leave this and `all` out to commit whatever is already staged."),
});
export const DiscardSchema = RepoParamSchema.extend({
    // Repo-relative paths to discard; absent ⇒ discard every uncommitted change in the repo.
    paths: z
        .array(z.string().min(1))
        .max(500)
        .optional()
        .describe("Which paths to throw away. Leave it out to discard every uncommitted change in the repository."),
});
// Index moves. Both are per-path and never touch the worktree, so they are always safe and need no checkpoint.
export const GitStageSchema = RepoParamSchema.extend({
    paths: z.array(z.string().min(1)).max(500).describe("The paths to move. Nothing on disk changes, so this is always safe and always reversible."),
});
// `branch` defaults to the checked-out one. There is deliberately no "set upstream" flag: the daemon publishes
// (`push -u`) exactly when the branch has no upstream yet, which is never destructive and is the only way the
// result is coherent, see pushBranch.
export const PushSchema = RepoParamSchema.extend({
    branch: z
        .string()
        .min(1)
        .optional()
        .describe("Which branch to push. Leave it out for the checked-out one. A branch with no upstream yet gets one set on this push."),
});
export const GitFileQuerySchema = RepoParamSchema.extend({ path: z.string().min(1).describe("The file to read, relative to the repository root.") });
export const GitFileWriteSchema = RepoParamSchema.extend({
    path: z.string().min(1).describe("Where to write, relative to the repository root. Missing folders are created."),
    content: z.string().describe("The file's whole new contents."),
});
// Which of the working tree's diffs to open, the same split the Changes panel lists under. A path that is
// staged AND edited again has genuinely different diffs, so the side is required rather than defaulted: a
// caller that doesn't say which one it means doesn't know what it is showing.
//   staged     ⇒ index vs HEAD      (what a bare `git commit` would record)
//   unstaged   ⇒ worktree vs index  (untracked ⇒ no before side)
//   conflicted ⇒ HEAD vs worktree   (what you had vs what the merge left, markers included, an unmerged path
//                                    has no stage 0, so the index is not a side it can be diffed against)
export const GitDiffSideSchema = z.enum(["staged", "unstaged", "conflicted"]);
export type GitDiffSide = z.infer<typeof GitDiffSideSchema>;
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
// CommitResultSchema is declared further down, after the RepoChanges/OriginAgent shapes a commit answers with.

// One repo's slice of a workspace-wide git action: the whole repo, or only the repo-relative paths named. The
// same pair the per-repo routes take as {repo} + `paths`, in the one shape a caller that spans repos can send.
export const RepoPathsSchema = z.object({
    repo: z.string().min(1).describe("Which repository."),
    paths: z.array(z.string().min(1)).max(500).optional().describe("Which of its paths. Leave it out for the whole repository."),
});
export type RepoPaths = z.infer<typeof RepoPathsSchema>;
// One change to a file, an uncommitted working-tree change (status vs HEAD, untracked included), an agent
// worktree's delta vs its base, or a file in a commit. `additions`/`deletions` are the numstat line counts,
// undefined for a binary file (git reports "-"/"-") or an untracked file (no HEAD blob to diff against).
export const GitChangeSchema = z.object({
    // Repo-relative path with forward slashes; for "renamed" the NEW path (`from` carries the old one).
    path: z.string().describe("The path, relative to the repository root. For a rename this is the new one."),
    // "conflicted" is git's unmerged state (`U`), and it is not a kind of modification: the index holds "ours"
    // and "theirs" at stages 2/3 with NO stage 0, so there is nothing a commit could record for this path and
    // git refuses to commit while one exists. It belongs to neither side, see RepoChanges.conflicted.
    status: z
        .enum(["added", "modified", "deleted", "renamed", "type-changed", "conflicted"])
        .describe("What happened to it. Conflicted is not a kind of edit: nothing can be committed anywhere in the repository while one exists."),
    from: z.string().optional().describe("Where a renamed file came from."),
    additions: z
        .number()
        .optional()
        .describe("Lines added. Absent for a binary file, and for an untracked one, which has nothing to compare against."),
    deletions: z.number().optional().describe("Lines removed. Absent for the same reasons additions is."),
    /* THE SAME CHANGE WITH THE COMMENTS TAKEN OUT, computed here rather than by whoever renders the row, and
     * that is the whole point of it being on the wire. A review's diffs open on code alone, so the numbers beside
     * them are the code's; working those out needs both whole sides of the file and a TextMate walk over each,
     * which the app used to do per file, as the files were read — so a row arrived showing git's count and
     * changed to this one the moment anything read it, which moved the row under the reader when the list was
     * sorted by size. Shipped with the list, the number a reader sees first is the number it stays.
     *
     * Absent, not zero, when there is nothing to say: a binary file, one side too large to read, a path whose
     * grammar this build does not ship, or a list too long to count whole (see git/code-counts.ts). The caller
     * then shows git's own counts, which for such a file are the only honest reading anyway. */
    code: z
        .object({ additions: z.number(), deletions: z.number() })
        .optional()
        .describe(
            "The same +/− with every comment stripped from both sides, which is what a review shows beside a diff that opens on code alone. Absent when the file cannot be read that way (binary, too large, or a language this build ships no grammar for): git's own counts above are then the reading.",
        ),
});
export type GitChange = z.infer<typeof GitChangeSchema>;
// Where a repo's checked-out branch stands against its remote. Every field is optional-or-zero because every
// one of them is legitimately absent in a healthy repo: no remote configured yet, a branch created locally and
// never pushed, a detached HEAD. `ahead` = commits only we have; `behind` = commits only the upstream has,
// which is meaningful only as of the last fetch, the panel's Fetch button is what refreshes it.
export const GitRemoteStateSchema = z.object({
    // The remote this branch pushes to: its OWN remote when it tracks one, else the first `git remote` lists
    // (where a never-pushed branch would publish). Those differ in a fork, `origin` and `upstream` both
    // configured, and pushing to the wrong one succeeds while leaving `ahead` stuck. Absent ⇒ no remote.
    remote: z
        .string()
        .optional()
        .describe(
            "The remote this branch pushes to. Absent means none is configured. In a fork with two remotes, pushing to the wrong one succeeds and leaves the count stuck, which is why this says which.",
        ),
    // The checked-out branch; absent on a detached HEAD or an unborn repo.
    branch: z.string().optional().describe("The checked-out branch. Absent when the repository is on a bare commit, or has no commits yet."),
    // The tracking ref ("origin/main"); absent ⇒ this branch has no upstream, so the next push publishes it.
    upstream: z.string().optional().describe("The branch on the remote this one follows. Absent means the next push will publish it."),
    ahead: z.number().describe("Commits you have that the remote does not."),
    behind: z.number().describe("Commits the remote has that you do not, as of the last fetch. Fetch before trusting it."),
});
export type GitRemoteState = z.infer<typeof GitRemoteStateSchema>;
// One local branch, for the switcher. `at` is its tip's committer time in ms (the list sorts newest-first).
export const GitBranchSchema = z.object({
    name: z.string().describe("The branch name."),
    current: z.boolean().describe("Whether this is the one checked out."),
    upstream: z.string().optional().describe("The branch on the remote it follows, if any."),
    ahead: z.number().describe("Commits this branch has that its remote counterpart does not."),
    behind: z.number().describe("Commits its remote counterpart has that it does not."),
    // The configured upstream no longer exists on the remote (a merged PR's deleted branch), distinct from
    // "no upstream", and the signal that this local branch is safe to delete.
    gone: z
        .boolean()
        .optional()
        .describe(
            "The branch it followed no longer exists on the remote, usually because a merged pull request deleted it. The signal that this one is safe to delete.",
        ),
    at: z.number().describe("When its tip was committed, in milliseconds. Lists are newest first."),
});
export type GitBranch = z.infer<typeof GitBranchSchema>;
/* One REMOTE-TRACKING branch, somebody else's tip, as this repo last saw it.
 *
 * A separate shape from GitBranch rather than the same one with optional fields, because the two genuinely
 * differ: a remote-tracking branch has no upstream of its own and no ahead/behind, and giving it those fields
 * as zeroes would make it look like a synced local branch. `name` is the full `origin/main`; `remote` and
 * `branch` are it split, so a selector can group by remote without re-parsing. */
export const GitRemoteBranchSchema = z.object({
    name: z.string().describe("The full name, such as origin/main."),
    remote: z.string().describe("Just the remote part, so a picker can group by it without re-parsing."),
    branch: z.string().describe("Just the branch part."),
    at: z.number().describe("When its tip was committed, in milliseconds, as this repository last saw it."),
});
export type GitRemoteBranch = z.infer<typeof GitRemoteBranchSchema>;
// Locals and remote-tracking branches in one response: the switcher pairs them, and two round trips to draw one
// list would only ever show a half-populated one first.
export const GitBranchesSchema = z.object({
    branches: z.array(GitBranchSchema).describe("Branches in this repository."),
    remotes: z
        .array(GitRemoteBranchSchema)
        .describe("Branches on its remotes, as last seen. Sent together with the locals so a switcher never draws a half-filled list."),
});
// Create at `start` (a sha or ref; absent ⇒ HEAD); `checkout` switches to it immediately (`git switch -c`).
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
/* THE OPERATION A REPO IS HALTED IN THE MIDDLE OF, a merge, rebase, cherry-pick or revert that stopped on a
 * conflict and was never finished or aborted.
 *
 * Every verb the daemon runs itself aborts cleanly on failure, so this is never something the UI started. It is
 * what an agent or a user left behind in a terminal, and it is a state git refuses to do almost anything else
 * from, so a surface listing the conflicted files without naming it leaves the reader with no way out.
 * Absent means the worktree is not mid-anything. */
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
    // Absent on an unborn HEAD (a repo initialized but never committed).
    branch: z.string().optional().describe("The checked-out branch. Absent in a repository that has no commits yet."),
    // Unmerged paths, a merge, rebase, cherry-pick or pull that git could not finish. First, because until
    // they are resolved nothing else in this repo can be committed at all: git refuses outright. Held apart
    // from the two sides rather than listed in them, because "staged or not" is not a question an unmerged path
    // has an answer to. Staging one (`git add`) is exactly how you tell git it is resolved.
    conflicted: z
        .array(GitChangeSchema)
        .describe(
            "Paths a merge or rebase could not finish. First, because nothing anywhere in this repository can be committed until they are resolved. Held apart from the two lists below, because staged or not is not a question one of these has an answer to.",
        ),
    /* The merge/rebase/cherry-pick/revert this repo is halted in the middle of, when it is. Carried on the SCAN
     * rather than fetched per repo because it belongs beside `conflicted`: the panel already lists the files,
     * and this is the sentence that says why they are conflicted and what ends it. Absent = not mid-anything,
     * which is every repo almost all of the time. */
    operation: GitOperationSchema.optional().describe(
        "What halted, when something did. This is the sentence that explains the conflicts above and names the way out of them.",
    ),
    // The two sides git actually models, kept apart because a path can appear on BOTH with different statuses
    // (a staged edit that was then edited again, the classic `MM`). `staged` is index-vs-HEAD: exactly what a
    // bare `git commit` would record. `unstaged` is worktree-vs-index plus untracked files. Each side's
    // additions/deletions describe the diff it is listed under, never a conflation of the two.
    staged: z.array(GitChangeSchema).describe("What a plain commit would record right now."),
    unstaged: z
        .array(GitChangeSchema)
        .describe(
            "Edits on disk that are not staged, plus untracked files. A path can be in both lists at once with different line counts, which is why they are separate.",
        ),
    // How many changes were CUT from the two sides above (conflicts are never cut). A cloned monorepo or a
    // mass delete carries six-figure change lists, a payload no panel can render and no browser should hold,
    // so past the daemon's per-repo budget the lists arrive truncated and this carries the dropped count, which
    // the panel adds to its badges and states under the group. Absent ⇒ the lists are complete.
    truncated: z
        .number()
        .optional()
        .describe(
            "How many changes were cut from the two lists above. A freshly cloned monorepo or a mass delete runs to six figures, which no screen can draw, so past a budget the lists arrive short and this says by how much. Absent means they are complete.",
        ),
    // Where this repo stands against its remote; `ahead`/`behind` are 0 with no remote or no upstream.
    remote: GitRemoteStateSchema.optional().describe("Where this repository stands against its remote."),
    // WHICH AGENT PUT IT THERE: repo-relative path → the agent ids that landed it, newest land first. Keyed by
    // PATH rather than carried on each GitChange because a path can be listed on two sides at once (staged and
    // edited again) and its origin is the same fact for both. Only branch-backed agents whose work passed
    // through land can appear here; workspace conversations, terminal edits and the user's typing are absent
    // (see agents/origins.ts), so the panel badges an attributable agent and says nothing for anyone else.
    // Ids, not titles: the identity for every id named here rides the response once, in `originAgents`.
    origins: z
        .record(z.string(), z.array(z.string()))
        .optional()
        .describe(
            "Which conversation put each path here, newest first, keyed by path. Only work that went through a merge can appear: edits made in the shared tree, in a terminal, or by a person are simply absent rather than guessed at.",
        ),
    // Why the repo could not be scanned at all, condensed to git's own one-line reason ("fatal: bad object HEAD").
    // A repo left torn by a canceled or failed upload used to be dropped from the response entirely, so it just
    // vanished from the panel with nothing to act on; it now arrives with empty change lists and this set instead.
    error: z
        .string()
        .optional()
        .describe(
            "Why the repository could not be read at all, in git's own words. A repository left broken by a failed import arrives with empty lists and this set, rather than vanishing from the answer with nothing to act on.",
        ),
});
export type RepoChanges = z.infer<typeof RepoChangesSchema>;
// WHO AN ORIGIN ID IS, the display identity of one agent named in `origins`, carried BY THE RESPONSE rather
// than looked up in the client's fleet roster. The roster is the LIVE board and deliberately drops archived
// agents (AgentsRegistry.list), while a landing outlives the agent that made it: archiving a finished agent
// does not commit its lines, so the very common case, land, archive the card, review at leisure, is exactly
// the one a roster lookup cannot answer, and the panel fell back to "Agent 1a2b3c" with a generic icon for it.
// The daemon reads attribution and identity from the same registry in the same pass, so it is the one place
// they cannot disagree. Per response, not per repo: one agent commonly lands into several.
export const OriginAgentSchema = z.object({
    // Absent for an entry that never got a title (a turn that failed before one was derived).
    title: z.string().optional().describe("The conversation's title. Absent for one that never got as far as having a title."),
    provider: AgentProviderSchema.describe("Which model provider it ran on."),
    /* WHAT THE LANDED WORK DID, the same drafted message the agent's own card carries (LandedMessage), on the
     * road that outlives the card. The panel reads the roster's copy first and this one when the roster has no
     * entry left to read, which is the case this whole schema exists for: an archived agent's lines are still
     * in the tree, and the sentence about them has to be too.
     *
     * Absent for a landing nothing was written about, and, for the seconds after a land, for one whose
     * sentence is still being drafted. Those two are told apart by `landedMessageDraft` on the agent's card, and
     * neither has a title-shaped fallback: guessing a subject from the ask is exactly the habit this replaced,
     * so a chip with no message files nothing and simply filters. */
    landedMessage: LandedMessageSchema.optional().describe(
        "What the merged work did, drafted by the conversation itself. Carried here as well as on its card, because merged lines outlive the card: archiving a finished conversation does not uncommit its work.",
    ),
});
export type OriginAgent = z.infer<typeof OriginAgentSchema>;
// The aggregated review set across every repo (root + every discovered repo); a repo appears when it has changes,
// when it is out of sync with its remote, or when it failed to scan.
export const GitChangesSchema = z.object({
    repos: z
        .array(RepoChangesSchema)
        .describe(
            "One entry per repository that has something pending, is out of step with its remote, or could not be read. A clean repository is simply absent.",
        ),
    // Keyed by agent id; covers every id any repo's `origins` names, and only those. Absent when nothing in
    // the review is attributable. An id can still be missing from it, the retention sweep can retire an
    // entry whose landed lines are somehow still uncommitted, and the panel keeps its id-shaped fallback for
    // exactly that, rather than dropping the chip and re-attributing the file to the user.
    originAgents: z
        .record(z.string(), OriginAgentSchema)
        .optional()
        .describe(
            "Who each conversation named above is, keyed by id, so a caller need not look them up. Absent when nothing in the review can be attributed.",
        ),
    /* WHICH REPOS HAVE A COMMIT RUNNING RIGHT NOW, the daemon's answer, not the browser's.
     *
     * A commit is one request that outlives the tab that fired it. Reload the page mid-commit and that tab's
     * "a git action is running" flag went with it: the button re-armed itself over rows the commit was already
     * recording, the panel invited a second click at the exact moment it could do the least good, and the rows
     * then changed under the user a second later with nothing having said why. A second device watching the
     * same workspace never knew at all.
     *
     * So the fact lives where the commit does. Read at RESPONSE time rather than folded into the scan, because
     * the scan is memoized for half a second and this must describe the instant it is sent. Absent ⇒ nothing is
     * committing, which is the overwhelmingly common case and the reason it is optional rather than an empty
     * array on every response. */
    committing: z
        .array(z.string())
        .optional()
        .describe(
            "Repositories with a commit running right now. The sandbox's answer rather than any one tab's, so a reload, a second window and another device all know. Absent means nothing is committing.",
        ),
});
export type GitChanges = z.infer<typeof GitChangesSchema>;
/* WHAT THE COMMIT LEFT BEHIND, the committed repo's review row, re-read inside the same repo lock that made
 * the commit, so the panel replaces that repo's rows from THIS answer instead of asking for a fresh
 * workspace-wide scan afterwards.
 *
 * That scan is the daemon's most expensive read (a repo walk plus a `git status` per repo, ~11 git spawns each,
 * for every repo including the ones the commit never touched) and the user sat watching the rows they had just
 * committed until it returned. The commit itself is milliseconds of git; the wait was this.
 *
 * `changes` ABSENT means the repo has nothing the panel would show any more, the same inclusion rule the scan
 * applies, decided in the same place, so a repo the scan would have dropped drops here too. `originAgents`
 * covers the ids this repo's `origins` names and only those, on GitChangesSchema's terms; the panel merges it
 * over what it already holds rather than replacing, since the other repos' rows still name their own agents. */
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
/* One module a changed file can be grouped under in the review panels: a repo-relative dir ("_editor/web", or ""
 * for a repo that is itself one package) and the name its package.json declares. Distinct from
 * WorkspacePackage, which is the DEPENDENCY graph's node, that one is pnpm's view of the workspace and carries
 * the grouping axis its diagram colours by; this one is a filesystem fact about where a path lives.
 *
 * Stated HERE, above both readings of it, because there are two trees a review can be of and each groups by its
 * own: the workspace read below (/workspace/modules, the Changes panel) speaks for /work, and every agent's
 * diff carries its own (AgentRepoChanges.modules) because an agent's files live in a worktree /work cannot
 * see. */
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
// One file an agent touched, plus whether that change is ALREADY in the main tree. The review lists the
// agent's CUMULATIVE output (base → worktree), not just the not-yet-landed remainder, because landing is not
// the end of the review: a clean turn auto-lands within milliseconds, and a list scoped to the remainder shows
// the user an empty panel for work they never got to look at. `landed` is what still separates the two, the
// remainder is what "Land now" would apply, and the panel filters on exactly this flag.
export const AgentChangeSchema = GitChangeSchema.extend({
    landed: z
        .boolean()
        .describe(
            "Whether this change is already in the shared tree. The list is everything the conversation wrote, not just what is left over, because a clean turn merges in milliseconds and a list of leftovers would show an empty panel for work nobody had looked at yet.",
        ),
});
export type AgentChange = z.infer<typeof AgentChangeSchema>;
// An agent conversation-worktree's delta vs its recorded base, deliberately NOT RepoChanges. There is no index
// side to speak of here: the question a fleet review answers is "what did this agent write", which is one flat
// set. Sharing the working-tree shape would have forced a meaningless empty `staged` on every
// row and invited the panel to render a staging affordance that cannot work on a worktree the user never checks out.
export const AgentRepoChangesSchema = z.object({
    repo: z.string().describe("Which repository."),
    branch: z.string().optional().describe("The branch this conversation's work sits on."),
    changes: z.array(AgentChangeSchema).describe("What it changed there."),
    /* THE PACKAGE LAYOUT OF THE TREE THESE CHANGES CAME FROM, so the review can group them by module the way
     * the workspace's Changes panel does. It rides the changes rather than being fetched beside them, because
     * an agent works in a worktree the main tree cannot see: a package the agent has just created exists only
     * there, so the workspace-wide read (/workspace/modules) does not know its name and every one of its files
     *, which for a new package is all of them, fell into the unnamed "loose in this repo" bucket.
     *
     * Same read, same instant, same tree as the rows it groups: that is what stops the two from disagreeing. */
    modules: z
        .array(WorkspaceModuleSchema)
        .describe(
            "The packages of the tree these changes came from, so a review can group by package. Carried with the changes rather than looked up separately, because a package the conversation has just created exists only in its own copy and the shared tree has never heard of it.",
        ),
});
export type AgentRepoChanges = z.infer<typeof AgentRepoChangesSchema>;
/* The review, plus WHY the last land refused, because a conflict is discovered by the daemon (a clean turn
 * auto-lands the moment it finishes) and acted on in the browser, possibly hours later, on a surface the user
 * reaches by clicking the card's "Resolve conflict". Carrying the report only in the land RESPONSE meant the
 * one path that opens the review already knowing there is a conflict was the one path that could not show it:
 * the panel opened with an empty report, no explanation, and no merge affordance, a dead end at the exact
 * moment the UI had promised something to resolve. It rides the review because that is the surface that
 * resolves it, and it refreshes with it: every land invalidates this query, so the report is never staler
 * than the last attempt. */
export const AgentChangesSchema = z.object({
    repos: z.array(AgentRepoChangesSchema).describe("One entry per repository the conversation touched."),
    conflicts: z
        .array(LandConflictSchema)
        .optional()
        .describe(
            "Why the last merge refused, when one did. Carried here as well as in the merge's own answer, because a conflict is found the moment a turn ends and dealt with hours later on this surface, which would otherwise open with nothing to explain what it promised to resolve.",
        ),
});
export type AgentChanges = z.infer<typeof AgentChangesSchema>;
