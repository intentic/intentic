import type { IntenticApi } from "@intentic/extension-api";
import { WorkspaceChildrenSchema } from "@intentic/sandbox-contract";
import { README_TAIL, stagingDir } from "./paths.js";

// Staged document tails relative to the set's root, for two callers: publish (copies each tail) and a run's advance
// step (derives which packages already have a page, making it idempotent since nothing is bookkept). One bounded-depth
// request, not one per directory.

// Covers a package nested three deep under a group directory, the realistic worst case here.
const MAX_DEPTH = 5;

export const listStagedTails = async (api: IntenticApi, repo: string): Promise<readonly string[]> => {
    const root = stagingDir(repo);
    try {
        const body = await api.sandbox.json(`/workspace/children?path=${encodeURIComponent(root)}&depth=${MAX_DEPTH}`);
        const prefix = `${root}/`;
        return WorkspaceChildrenSchema.parse(body)
            .entries.filter((entry) => entry.type === `file` && entry.path.startsWith(prefix))
            .map((entry) => entry.path.slice(prefix.length))
            .toSorted();
    } catch {
        // A directory that is not there is the ordinary answer for a repo with nothing staged.
        return [];
    }
};

// Package dirs with a staged page: a README tail's directory part. The map's own tails sit at the root, with no
// directory part, so they can't be mistaken for one.
export const documentedDirs = (tails: readonly string[]): readonly string[] =>
    tails.filter((tail) => tail.endsWith(`/${README_TAIL}`)).map((tail) => tail.slice(0, -`/${README_TAIL}`.length));
