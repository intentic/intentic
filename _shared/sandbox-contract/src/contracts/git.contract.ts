import { oc } from "@orpc/contract";
import {
    CommitResultSchema,
    CommitSchema,
    DiscardSchema,
    GitBranchCreateAtSchema,
    GitBranchDeleteSchema,
    GitBranchesSchema,
    GitChangesSchema,
    GitFileDiffQuerySchema,
    GitFileQuerySchema,
    GitFileSchema,
    GitFilesSchema,
    GitFileWriteSchema,
    GitIndexMoveSchema,
    GitOperationStateSchema,
    GitRemoteStateSchema,
    GitStatusSchema,
    PushRunSchema,
    PushSchema,
} from "../schemas/git.js";
import {
    GitActionResultSchema,
    GitBranchCreateSchema,
    GitCheckoutSchema,
    GitCommitActionSchema,
    GitCommitDiffQuerySchema,
    GitCommitDiffSchema,
    GitCommitFileDiffQuerySchema,
    GitLogQuerySchema,
    GitLogSchema,
    GitPublishFileResultSchema,
    GitPublishFileSchema,
    GitRemoteReposSchema,
    GitReposSchema,
    GitResetSchema,
    GitTagCreateSchema,
    GitTagDeleteSchema,
    GitTagPushSchema,
    GitUndoSchema,
    GitUndoStateSchema,
    StashApplySchema,
    StashDiffQuerySchema,
    StashListSchema,
    StashPushSchema,
    StashRefParamSchema,
} from "../schemas/git-history.js";
import { FileDiffSchema } from "../schemas/history.js";
import { OkSchema, RepoParamSchema } from "../schemas/shared.js";

// Per-repo git ops over the workspace repos; `root` is /work, others are discovered under it, and {repo} is the
// root-relative dir, URL-encoded. Unknown {repo} throws NOT_FOUND, an escaping path throws BAD_REQUEST. `changes` is
// the workspace-wide review set; commit/discard take optional `paths`.
export const gitContract = {
    changes: oc
        .route({
            method: "GET",
            path: "/git/changes",
            summary: "Uncommitted work across every repo",
            description:
                "The workspace's whole review set in one answer: every repo that has something uncommitted, and within it every changed file with its status and line counts. This is what the Changes panel draws, and it is the call to make when you want to know whether a workspace is clean without walking the repos yourself.",
        })
        .output(GitChangesSchema),
    // Read-only: repo list, commit log, lazy per-commit diff; commit/discard on the tree are a separate write path.
    repos: oc
        .route({
            method: "GET",
            path: "/git/repos",
            summary: "Every git repo in the workspace",
            description:
                "The repos the daemon found under the workspace root, each with the id every other call in this group expects as its `{repo}` segment. The workspace root itself is always present as `root`.",
        })
        .output(GitReposSchema),
    // Same repos with the remote's host and `owner/name`; kept off `repos` since it costs a lookup per repo.
    remoteRepos: oc
        .route({
            method: "GET",
            path: "/git/remote-repos",
            summary: "Repos matched to their remotes",
            description:
                "The same repo list, but with the forge host and `owner/name` each one's remote points at. Use it to recognise a workspace repo in a list of names that came from somewhere else, such as a set of pull requests. Costs a remote lookup per repo, which is why it is separate from the plain repo list.",
        })
        .output(GitRemoteReposSchema),
    log: oc
        .route({
            method: "GET",
            path: "/git/{repo}/log",
            summary: "Commit history for one repo",
            description:
                "A page of commits on the current branch, newest first, each with its author, subject, timestamp and the refs pointing at it. Paginate with the cursor the answer hands back rather than by offset, so a commit landing mid-scroll does not shift the page under you.",
        })
        .input(GitLogQuerySchema)
        .output(GitLogSchema),
    commitDiff: oc
        .route({
            method: "GET",
            path: "/git/{repo}/commit-diff",
            summary: "What one commit changed",
            description:
                "The list of files a single commit touched, with per-file status and line counts but not the content. Fetch the content of any one of them with the commit file diff call, so a commit with a thousand files stays one cheap answer.",
        })
        .input(GitCommitDiffQuerySchema)
        .output(GitCommitDiffSchema),
    commitFileDiff: oc
        .route({
            method: "GET",
            path: "/git/{repo}/commit-file-diff",
            summary: "One file's before and after at a commit",
            description:
                "Both sides of a single file as of one commit: the content its parent had and the content that commit left. The daemon returns whole sides rather than a patch, so a caller can render the comparison however it likes.",
        })
        .input(GitCommitFileDiffQuerySchema)
        .output(FileDiffSchema),
    // Non-destructive writes return Ok; HEAD-moving ops return a GitActionResult, a conflict is a value not 500.
    // `abort` is git's own `--abort`, the only way out of what `operation` reports; daemon verbs self-abort.
    operation: oc
        .route({
            method: "GET",
            path: "/git/{repo}/operation",
            summary: "Whether a merge or rebase is halted mid-flight",
            description:
                "Names the git operation the worktree is stuck inside, if any: a conflicted merge, an interrupted rebase, a half-applied cherry-pick. Check this first when another call refuses, because a halted worktree is the usual reason and the abort call is the way out.",
        })
        .input(RepoParamSchema)
        .output(GitOperationStateSchema),
    abort: oc
        .route({
            method: "POST",
            path: "/git/{repo}/abort",
            summary: "Abandon a halted merge or rebase",
            description:
                "Runs git's own abort for whichever operation has the worktree halted, putting the repo back where it stood before the operation started. Nothing else clears that state.",
        })
        .input(RepoParamSchema)
        .output(GitActionResultSchema),
    // Moves the branch ref via reflog; requires `previousSha` from the matching read as a concurrency token.
    undoable: oc
        .route({
            method: "GET",
            path: "/git/{repo}/undo",
            summary: "What undoing the last action would do",
            description:
                "Reads the branch's reflog to describe the move that undo would reverse, and hands back the commit it would land on. Pass that commit to the undo call as proof you looked, and an undo prepared against a view that has since moved is refused rather than landing somewhere unexamined.",
        })
        .input(RepoParamSchema)
        .output(GitUndoStateSchema),
    undo: oc
        .route({
            method: "POST",
            path: "/git/{repo}/undo",
            summary: "Move the branch back one step",
            description:
                "Walks the current branch back to where it pointed before its last action. This moves the branch ref and leaves the working tree alone, which is the opposite of restoring a checkpoint. Requires the commit the matching read handed you.",
        })
        .input(GitUndoSchema)
        .output(GitActionResultSchema),
    // A stash entry is a commit, read like the log/diff pair; only `drop` is unrecoverable and checkpoints first.
    stashes: oc
        .route({
            method: "GET",
            path: "/git/{repo}/stashes",
            summary: "Everything set aside in the stash",
            description:
                "The repo's stash entries, newest first, each with the message and the commit behind it. A stash entry is a commit, so it reads the same way a log entry does and its contents come back from the stash diff call.",
        })
        .input(RepoParamSchema)
        .output(StashListSchema),
    stashDiff: oc
        .route({
            method: "GET",
            path: "/git/{repo}/stash-diff",
            summary: "What one stash entry holds",
            description:
                "The files a single stash entry would bring back, with per-file status and line counts. The same shape a commit diff has, because a stash entry is a commit.",
        })
        .input(StashDiffQuerySchema)
        .output(GitCommitDiffSchema),
    stashPush: oc
        .route({
            method: "POST",
            path: "/git/{repo}/stash",
            summary: "Set the current changes aside",
            description:
                "Moves the working tree's changes onto the stash and leaves a clean tree behind. Nothing is lost: the entry is a commit you can inspect, apply or drop afterwards.",
        })
        .input(StashPushSchema)
        .output(GitActionResultSchema),
    stashApply: oc
        .route({
            method: "POST",
            path: "/git/{repo}/stash/apply",
            summary: "Bring a stash entry back",
            description:
                "Replays one stash entry onto the working tree. A conflict is reported in the answer rather than raised as a failure, because a conflicting apply is an ordinary outcome a screen has to render.",
        })
        .input(StashApplySchema)
        .output(GitActionResultSchema),
    stashDrop: oc
        .route({
            method: "POST",
            path: "/git/{repo}/stash/drop",
            summary: "Discard a stash entry",
            description:
                "Deletes one stash entry. This is the only unrecoverable call in the stash set, so the daemon takes a checkpoint of the workspace first.",
        })
        .input(StashRefParamSchema)
        .output(OkSchema),
    createBranch: oc
        .route({
            method: "POST",
            path: "/git/{repo}/branch",
            summary: "Start a branch at a commit",
            description: "Points a new branch name at any commit, without moving HEAD. Use the checkout call if you also want to switch to it.",
        })
        .input(GitBranchCreateSchema)
        .output(OkSchema),
    createTag: oc
        .route({
            method: "POST",
            path: "/git/{repo}/tag",
            summary: "Tag a commit",
            description: "Puts a tag on any commit. Local only: pushing it to the remote is a separate call.",
        })
        .input(GitTagCreateSchema)
        .output(OkSchema),
    deleteTag: oc
        .route({
            method: "POST",
            path: "/git/{repo}/tag/delete",
            summary: "Remove a tag",
            description: "Deletes a tag locally. A tag already pushed stays on the remote until it is deleted there too.",
        })
        .input(GitTagDeleteSchema)
        .output(OkSchema),
    pushTag: oc
        .route({
            method: "POST",
            path: "/git/{repo}/tag/push",
            summary: "Send a tag to the remote",
            description:
                "Pushes one tag to the repo's remote. Reports the outcome rather than failing, since a missing remote or missing credentials are ordinary answers here.",
        })
        .input(GitTagPushSchema)
        .output(GitActionResultSchema),
    checkout: oc
        .route({
            method: "POST",
            path: "/git/{repo}/checkout",
            summary: "Switch to a branch or commit",
            description:
                "Moves HEAD to a branch, tag or commit and reshapes the working tree to match. The daemon takes a checkpoint first, so an unexpected result is recoverable. Uncommitted work that would be overwritten is reported instead of being trampled.",
        })
        .input(GitCheckoutSchema)
        .output(GitActionResultSchema),
    cherryPick: oc
        .route({
            method: "POST",
            path: "/git/{repo}/cherry-pick",
            summary: "Replay one commit onto this branch",
            description:
                "Applies a single commit's changes on top of the current branch as a new commit. A conflict comes back in the answer, with the halted state readable from the operation call.",
        })
        .input(GitCommitActionSchema)
        .output(GitActionResultSchema),
    revert: oc
        .route({
            method: "POST",
            path: "/git/{repo}/revert",
            summary: "Undo a commit with a new commit",
            description:
                "Adds a commit that reverses an earlier one, leaving the history intact. This is the safe way to take something back on a branch other people have pulled.",
        })
        .input(GitCommitActionSchema)
        .output(GitActionResultSchema),
    drop: oc
        .route({
            method: "POST",
            path: "/git/{repo}/drop",
            summary: "Remove a commit from history",
            description:
                "Rewrites the branch so one commit is no longer in it. History changes, so this is for branches nobody else has pulled. A checkpoint is taken first.",
        })
        .input(GitCommitActionSchema)
        .output(GitActionResultSchema),
    merge: oc
        .route({
            method: "POST",
            path: "/git/{repo}/merge",
            summary: "Merge another branch in",
            description:
                "Merges a branch or commit into the current one. Conflicts are reported in the answer and leave the worktree halted, which the operation call explains and the abort call clears.",
        })
        .input(GitCommitActionSchema)
        .output(GitActionResultSchema),
    rebase: oc
        .route({
            method: "POST",
            path: "/git/{repo}/rebase",
            summary: "Replay this branch onto another",
            description:
                "Moves the current branch's commits on top of a different base. History changes. Conflicts halt the rebase and are reported rather than raised, so the operation and abort calls are the way through.",
        })
        .input(GitCommitActionSchema)
        .output(GitActionResultSchema),
    reset: oc
        .route({
            method: "POST",
            path: "/git/{repo}/reset",
            summary: "Move the branch to a commit",
            description:
                "Repoints the current branch at another commit, optionally reshaping the working tree to match. The destructive modes take a checkpoint first.",
        })
        .input(GitResetSchema)
        .output(GitActionResultSchema),
    fileDiff: oc
        .route({
            method: "GET",
            path: "/git/{repo}/file-diff",
            summary: "One file's committed and working copies",
            description:
                "Both sides of a file as it stands right now: what the last commit holds and what is on disk. This is what a review pane shows for an uncommitted change.",
        })
        .input(GitFileDiffQuerySchema)
        .output(FileDiffSchema),
    status: oc
        .route({
            method: "GET",
            path: "/git/{repo}/status",
            summary: "One repo's branch and pending changes",
            description:
                "The current branch, its sync position against the remote, and every staged, unstaged and untracked path. The single-repo counterpart to the workspace-wide changes call.",
        })
        .input(RepoParamSchema)
        .output(GitStatusSchema),
    commit: oc
        .route({
            method: "POST",
            path: "/git/{repo}/commit",
            summary: "Commit the pending changes",
            description:
                "Records a commit with your message. It commits whatever is staged; add `stage` to stage something first — an empty object for everything pending, or a scope such as one side or one conversation's landed files. The answer carries the commit it created.",
        })
        .input(CommitSchema)
        .output(CommitResultSchema),
    discard: oc
        .route({
            method: "POST",
            path: "/git/{repo}/discard",
            summary: "Throw away pending changes",
            description:
                "Restores files to their committed state and deletes untracked ones. Name paths or a scope to narrow it; with neither it throws away every uncommitted change in the repository. The daemon checkpoints the workspace first, so this is recoverable from the timeline.",
        })
        .input(DiscardSchema)
        .output(OkSchema),
    // Take a scope, not a path list, so it covers files the caller never enumerated; the worktree is untouched.
    stage: oc
        .route({
            method: "POST",
            path: "/git/{repo}/stage",
            summary: "Mark changes for the next commit",
            description:
                "Adds changes to the index: exactly the paths you name, everything a scope describes, or the whole repository when you name neither. Nothing on disk changes, so this is always safe and always reversible with the unstage call.",
        })
        .input(GitIndexMoveSchema)
        .output(OkSchema),
    unstage: oc
        .route({
            method: "POST",
            path: "/git/{repo}/unstage",
            summary: "Take changes back out of the next commit",
            description:
                "Removes changes from the index and leaves the files themselves untouched, on the same terms as staging. The exact reverse of it.",
        })
        .input(GitIndexMoveSchema)
        .output(OkSchema),
    // `branches` includes per-branch ahead/behind, so the switcher renders sync state without a call per branch.
    branches: oc
        .route({
            method: "GET",
            path: "/git/{repo}/branches",
            summary: "Local branches and how far each has drifted",
            description:
                "Every local branch with how many commits it sits ahead of and behind its remote counterpart, so a branch switcher can show sync state without a call per branch.",
        })
        .input(RepoParamSchema)
        .output(GitBranchesSchema),
    createBranchAt: oc
        .route({
            method: "POST",
            path: "/git/{repo}/branches",
            summary: "Create a branch from a starting point",
            description:
                "Makes a branch at a named start point and optionally switches to it. The branch-switcher counterpart to creating a branch at a specific commit.",
        })
        .input(GitBranchCreateAtSchema)
        .output(OkSchema),
    deleteBranch: oc
        .route({
            method: "POST",
            path: "/git/{repo}/branches/delete",
            summary: "Delete a local branch",
            description:
                "Removes a branch from the repo. Unmerged work is refused unless you ask for it to be forced, and the remote branch is untouched either way.",
        })
        .input(GitBranchDeleteSchema)
        .output(OkSchema),
    // Reflects the last fetch, not a live check; writes below report a GitActionResult, not a throw, on failure.
    remote: oc
        .route({
            method: "GET",
            path: "/git/{repo}/remote",
            summary: "Sync position against the remote",
            description:
                "How far the current branch sits ahead of and behind its remote, as of the last fetch, plus whether a remote and working credentials exist at all. This is a read of what the daemon already knows, not a network call, which is why fetching is a separate button.",
        })
        .input(RepoParamSchema)
        .output(GitRemoteStateSchema),
    fetch: oc
        .route({
            method: "POST",
            path: "/git/{repo}/fetch",
            summary: "Refresh what the remote holds",
            description:
                "Contacts the remote and updates the daemon's picture of it without touching your branch. Run this before trusting the sync position.",
        })
        .input(RepoParamSchema)
        .output(GitActionResultSchema),
    pull: oc
        .route({
            method: "POST",
            path: "/git/{repo}/pull",
            summary: "Bring remote commits down",
            description:
                "Fetches and integrates the remote's commits into the current branch. A pull that cannot fast-forward is reported in the answer rather than raised, because that is an ordinary thing to be told.",
        })
        .input(RepoParamSchema)
        .output(GitActionResultSchema),
    // Starts the push and returns at once; poll `pushState` for the verdict, since it runs the pre-push hook.
    push: oc
        .route({
            method: "POST",
            path: "/git/{repo}/push",
            summary: "Start sending commits to the remote",
            description:
                "Starts pushing the current branch, setting its upstream on first push, and answers at once: the push runs in a real terminal (it runs this repository's pre-push hook, which can be a whole suite), so watch it there and poll pushState for the verdict. A second start while one is going joins it rather than pushing twice.",
        })
        .input(PushSchema)
        .output(OkSchema),
    pushState: oc
        .route({
            method: "GET",
            path: "/git/{repo}/push",
            summary: "How the push is going",
            description:
                "The verdict, or the progress so far: where it is, the terminal it runs in, and for a push that did not go, git's last words and who refused it, the repository's own pre-push hook, the remote, or the transport. Idle when nothing has been started for this repository.",
        })
        .input(RepoParamSchema)
        .output(PushRunSchema),
    pushCancel: oc
        .route({
            method: "POST",
            path: "/git/{repo}/push/cancel",
            summary: "Stop the push",
            description: "Kills the run. It settles as cancelled; nothing that git had not already sent reaches the remote.",
        })
        .input(RepoParamSchema)
        .output(OkSchema),
    files: oc
        .route({
            method: "GET",
            path: "/git/{repo}/files",
            summary: "Every tracked path in the repo",
            description:
                "The flat list of files git tracks, which is what a file picker or a search box wants. Ignored and untracked files are not in it.",
        })
        .input(RepoParamSchema)
        .output(GitFilesSchema),
    readFile: oc
        .route({
            method: "GET",
            path: "/git/{repo}/file",
            summary: "Read a file from the repo",
            description: "The contents of one file as it stands on disk. A path that climbs out of the repo is refused.",
        })
        .input(GitFileQuerySchema)
        .output(GitFileSchema),
    writeFile: oc
        .route({
            method: "PUT",
            path: "/git/{repo}/file",
            summary: "Write a file into the repo",
            description:
                "Replaces one file's contents, creating it and its parent folders if they are missing. Nothing is committed: the change shows up as pending work.",
        })
        .input(GitFileWriteSchema)
        .output(OkSchema),
    // Writes, commits only this path, and pushes in one call; no remote, no credentials, wrong branch are reported.
    publishFile: oc
        .route({
            method: "POST",
            path: "/git/{repo}/publish-file",
            summary: "Write, commit and push one file",
            description:
                "The three steps as a single call with a single answer, committing only the path you named and leaving any other pending work alone. Being on a side branch, having no remote and having no credentials are all reported rather than raised.",
        })
        .input(GitPublishFileSchema)
        .output(GitPublishFileResultSchema),
};
