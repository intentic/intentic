import type { Samples } from "../smoke-daemon.ts";
import type { GroupSamples } from "./context.ts";
import { seedSha } from "../../src/daemon/git/gitSha.ts";

// The git area's inputs, sent in this order against one live graph per repo: stage and take back the same file, commit
// it, stage it as a run, throw away another; read the log and a seeded commit; branch and tag, then delete both; verbs
// that leave the branch where it was (a merge and a rebase onto an ancestor, a cherry-pick and a drop git refuses);
// abort the recording's halted cherry-pick, then a revert that the undo after it walks back; fetch, pull, a push started
// and stopped; a stash applied, then dropped. Commits are named by the ids their seeds always get.
const web = (seed: string): string => seedSha(`web`, seed);
const api = (seed: string): string => seedSha(`api`, seed);

const GIT_SAMPLES: Samples[`git`] = {
    repos: undefined,
    changes: undefined,
    viewChanges: { view: { repo: `api`, branch: `feature/rate-limits` } },
    branchLandings: { repo: `api`, branch: `feature/rate-limits` },
    fileDiff: { repo: `web`, path: `src/lib/checkout.ts`, side: `unstaged` },
    branches: { repo: `web` },
    stage: { repo: `web`, paths: [`src/lib/checkout.ts`] },
    unstage: { repo: `web`, paths: [`src/lib/checkout.ts`] },
    commit: { repo: `web`, message: `smoke`, stage: { paths: [`src/lib/checkout.ts`] } },
    indexRunStart: { repo: `web`, op: `stage`, target: { paths: [`src/lib/checkout.ts`] } },
    indexRunState: { repo: `web` },
    indexRunCancel: { repo: `web` },
    discard: { repo: `web`, paths: [`tests/checkout.spec.ts`] },
    log: { repo: `web`, limit: 50 },
    commitDiff: { repo: `web`, sha: web(`w8`) },
    commitFileDiff: { repo: `web`, sha: web(`w8`), path: `src/lib/checkout.ts` },
    readFile: { repo: `web`, path: `README.md` },
    createBranch: { repo: `web`, sha: web(`w7`), name: `smoke/at` },
    createBranchAt: { repo: `web`, name: `smoke/branch`, start: `main` },
    deleteBranch: { repo: `web`, name: `smoke/branch` },
    checkout: { repo: `web`, ref: `main` },
    returnToMainLine: { repo: `web` },
    createTag: { repo: `web`, sha: web(`w7`), name: `smoke-tag` },
    pushTag: { repo: `web`, name: `smoke-tag`, remote: `origin` },
    deleteTag: { repo: `web`, name: `smoke-tag`, remote: `origin` },
    merge: { repo: `web`, sha: web(`w7`) },
    rebase: { repo: `web`, sha: web(`w7`) },
    cherryPick: { repo: `web`, sha: web(`w7`) },
    drop: { repo: `api`, sha: api(`ar1`) },
    operation: { repo: `api` },
    abort: { repo: `api` },
    revert: { repo: `api`, sha: api(`a7`) },
    undoable: { repo: `api` },
    undo: { repo: `api`, previousSha: api(`a8`), discardChanges: false },
    reset: { repo: `api`, sha: api(`a8`), mode: `soft` },
    fetch: { repo: `api` },
    pull: { repo: `api` },
    push: { repo: `api`, branch: `feature/rate-limits` },
    pushState: { repo: `api` },
    pushCancel: { repo: `api` },
    remoteRepos: undefined,
    publishFile: { repo: `root`, path: `NOTES.md`, content: `smoke`, message: `smoke` },
    stashes: { repo: `web` },
    stashDiff: { repo: `web`, ref: `stash@{0}` },
    stashApply: { repo: `web`, ref: `stash@{0}`, pop: false },
    stashDrop: { repo: `web`, ref: `stash@{0}` },
};

export const gitSamples: GroupSamples<`git`> = () => GIT_SAMPLES;
