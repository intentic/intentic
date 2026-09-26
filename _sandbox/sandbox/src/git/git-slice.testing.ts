import { unstubbed } from "@intentic/testing";
import type { GitSlice } from "./git-slice.js";

// The git slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

// Thirty-seven methods, a route touches two: a suite passes the ones it means and the rest self-name if reached.
export interface GitFakeOverrides {
    readonly git?: Partial<GitSlice["git"]> | undefined;
}

// A clean repo on `main` with nothing staged, stashed, ahead or behind, and every write succeeding. The routes reach a
// dozen of these, the rest stay unstubbed. A module constant, since each fake spreads it into an object of its own.
const cleanRepo = {
    init: async () => {},
    status: async () => ({ branch: "main", dirty: false, files: [] }),
    listFiles: async () => [],
    commitAll: async () => false,
    clone: async () => {},
    changedFiles: async () => ({ conflicted: [], staged: [], unstaged: [], blobs: new Map() }),
    stagePaths: async () => {},
    stageAll: async () => {},
    scratchOf: async () => [],
    unstagePaths: async () => {},
    commitIndex: async () => false,
    discardPaths: async () => {},
    deleteTag: async () => {},
    pushTag: async () => ({ ok: true as const }),
    listBranches: async () => [],
    listRemoteBranches: async () => [],
    createBranch: async () => {},
    deleteBranch: async () => {},
    remoteState: async () => ({ ahead: 0, behind: 0 }),
    // Not mid-anything, which is almost every repo almost always; a halted-repo test overrides this.
    operationInProgress: async () => undefined,
    abortOperation: async () => {},
    stashList: async () => [],
    stashChanges: async () => [],
    stashPush: async () => ({ ok: true as const }),
    stashApply: async () => ({ ok: true as const }),
    stashDrop: async () => {},
    undoableAction: async () => undefined,
    undoLastAction: async () => ({ ok: false as const, reason: "nothing to undo" }),
    fetchRemote: async () => ({ ok: true as const }),
    pullRemote: async () => ({ ok: true as const }),
    stagedFileDiff: async () => ({}),
    unstagedFileDiff: async () => ({}),
    fileDiff: async () => ({}),
} satisfies Partial<GitSlice["git"]>;

export const gitSliceFake = ({ git }: GitFakeOverrides) => ({ git: unstubbed<GitSlice["git"]>("git", { ...cleanRepo, ...git }) }) satisfies GitSlice;
