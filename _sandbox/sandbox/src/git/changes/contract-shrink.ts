import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { lockShrinkage } from "@intentic/constants/contract-shrink";
import { defaultGit, type GitRunner } from "@intentic/scaffold";

// Detects a wire-contract shrink when the landing commit message is drafted (agents/landed-subject.ts) and forces the
// `!`/Breaking-Note onto it, using the same comparison (@intentic/constants/contract-shrink) as the push gate
// (_tools/checks/contract-shrink.mjs).
// Any file with this basename is a wire-contract lock: JSON whose top-level keys are exported schema names.
const CONTRACT_LOCK_NAME = `contract.lock.json`;

// What committing `paths` would remove from the wire contract vs HEAD (not any merge-base), for each claimed path that
// is a lock; never throws, since a draft must not fail a land.
export const claimedContractShrink = async (dir: string, paths: readonly string[], git: GitRunner = defaultGit): Promise<string[]> => {
    const removed: string[] = [];
    for (const path of paths.filter((candidate) => basename(candidate) === CONTRACT_LOCK_NAME)) {
        const base = await git(dir, [`show`, `HEAD:${path}`])
            .then((result) => result.stdout)
            .catch(() => undefined);
        const head = base === undefined ? undefined : await readFile(join(dir, path), `utf8`).catch(() => undefined);
        if (base !== undefined && head !== undefined) {
            removed.push(...lockShrinkage(base, head));
        }
    }
    return removed;
};
