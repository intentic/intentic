import { refuse } from "@intentic/contract-serve";
import { fileBody, fileDiff, REMOTE_REPOS, REPOS } from "../../fixture/workspace";
import { graphOf } from "./gitGraph";
import { commit, dirtyPaths, discard, gitChanges, indexRunState, stage, startIndexRun, unstage } from "./gitIndex";
import { pendingDiff } from "./gitPending";
import { cancelPush, fetch, publishFile, pull, pushState, pushTag, startPush } from "./gitPush";
import { branchList, commitDiff, commitFileDiff, gitLog, stashDiff, stashList, undoableOf } from "./gitReads";
import { abort, checkout, createBranch, createBranchAt, createTag, deleteBranch, deleteTag, operation, stashApply, stashDrop } from "./gitRefs";
import { cherryPick, drop, merge, rebase, reset, revert, undo } from "./gitRewrite";
import type { Doors } from "../doors";

// Every repo's git, simulated for the page load over one commit graph per repo (daemon/gitGraph.ts): the index moves and
// commits of the Changes panel, the log, branches, tags, stash and undo of the history view, and fetch, pull and push
// against a simulated remote. A write changes what the next read says, and moves the refs every open window re-reads.

// A file as it stands on disk; a path the workspace does not carry is the daemon's NOT_FOUND.
const onDisk = (repo: string, path: string) => {
    graphOf(repo);
    const content = fileBody(repo === `root` ? path : `${repo}/${path}`);
    return content === undefined ? refuse(`not found`, 404) : { path, content };
};

export const gitDoors = {
    repos: () => ({ repos: [...REPOS] }),
    changes: () => gitChanges(),
    fileDiff: ({ repo, path }) => pendingDiff(repo, path) ?? fileDiff(repo, path),
    branches: ({ repo }) => branchList(repo),
    stage: ({ repo, ...target }) => stage(repo, target),
    unstage: ({ repo, ...target }) => unstage(repo, target),
    commit: ({ repo, message, stage: stageFirst }) => commit(repo, message, stageFirst),
    indexRunStart: (start) => startIndexRun(start),
    indexRunState: ({ repo }) => indexRunState(repo),
    indexRunCancel: () => ({ ok: true }),
    discard: ({ repo, ...target }) => discard(repo, target),
    log: ({ repo, limit, skip }) => gitLog(repo, limit, skip),
    commitDiff: ({ repo, sha }) => commitDiff(repo, sha),
    commitFileDiff: ({ repo, sha, path }) => commitFileDiff(repo, sha, path),
    readFile: ({ repo, path }) => onDisk(repo, path),
    operation: ({ repo }) => operation(repo),
    abort: ({ repo }) => abort(repo),
    undoable: ({ repo }) => {
        const action = undoableOf(graphOf(repo));
        return action === undefined ? { repo } : { repo, action };
    },
    undo: ({ repo, previousSha, discardChanges }) => undo(repo, previousSha, discardChanges === true),
    stashes: ({ repo }) => stashList(repo),
    stashDiff: ({ repo, ref }) => stashDiff(repo, ref),
    stashApply: ({ repo, ref, pop }) => stashApply(repo, ref, pop === true, dirtyPaths(repo)),
    stashDrop: ({ repo, ref }) => stashDrop(repo, ref),
    checkout: ({ repo, ref }) => checkout(repo, ref),
    createBranch: ({ repo, sha, name }) => createBranch(repo, sha, name),
    createBranchAt: ({ repo, name, start, checkout: andCheckout }) => createBranchAt(repo, name, start, andCheckout === true),
    deleteBranch: ({ repo, name, force }) => deleteBranch(repo, name, force === true),
    createTag: ({ repo, sha, name }) => createTag(repo, sha, name),
    deleteTag: ({ repo, name, remote }) => deleteTag(repo, name, remote),
    pushTag: ({ repo, name, remote }) => pushTag(repo, name, remote),
    merge: ({ repo, sha }) => merge(repo, sha),
    rebase: ({ repo, sha }) => rebase(repo, sha),
    cherryPick: ({ repo, sha }) => cherryPick(repo, sha),
    revert: ({ repo, sha }) => revert(repo, sha),
    drop: ({ repo, sha }) => drop(repo, sha),
    reset: ({ repo, sha, mode }) => reset(repo, sha, mode),
    fetch: ({ repo }) => fetch(repo),
    pull: ({ repo }) => pull(repo),
    push: ({ repo, branch }) => startPush(repo, branch),
    pushState: ({ repo }) => pushState(repo),
    pushCancel: ({ repo }) => cancelPush(repo),
    // Where each repo lives online, matched against the registry for the publish path picker.
    remoteRepos: () => ({ repos: [...REMOTE_REPOS] }),
    publishFile: ({ repo, path, content, message }) => publishFile(repo, path, content, message),
} satisfies Doors<`git`>;
