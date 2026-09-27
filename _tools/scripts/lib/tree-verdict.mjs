// Caches pass/fail verdicts against a hash of a tree's content (`git write-tree` over index+add -A), so identical content
// is not re-measured. Stored as `verdict` entries of the push store in the common git dir (lib/push-store.mjs), shared
// across worktrees and with what pushes leave, the newest VERDICTS_KEPT. `pnpm verify` writes a `verify` verdict, and
// verify-push.mjs writes `push` and reads both, matching the working tree or any pushed commit's own tree.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { git } from "./git.mjs";
import { legacyVerdictPath, readArray, readStore, writeStore } from "./push-store.mjs";

// A verdict older than this is re-measured even for an identical tree: node_modules is not in the hash.
export const VERDICT_TTL_MS = 12 * 60 * 60_000;
export { VERDICTS_KEPT } from "./push-store.mjs";

// Hash of the working tree's content; `undefined` when git can't answer, which reads as "no verdict" and re-measures.
export const treeHash = (root) => {
    const indexPath = git(root, "rev-parse", "--git-path", "index")?.trim();
    if (indexPath === undefined) {
        return undefined;
    }
    const scratch = mkdtempSync(join(tmpdir(), "tree-verdict-"));
    try {
        const copy = join(scratch, "index");
        const source = resolve(root, indexPath);
        if (existsSync(source)) {
            copyFileSync(source, copy);
        }
        const env = { ...process.env, GIT_INDEX_FILE: copy };
        if (spawnSync("git", ["add", "-A", "."], { cwd: root, env, stdio: "ignore" }).status !== 0) {
            return undefined;
        }
        const tree = spawnSync("git", ["write-tree"], { cwd: root, env, encoding: "utf8" });
        return tree.status === 0 ? tree.stdout.trim() : undefined;
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
};

// The tree a commit carries, which is what CI checks out; `undefined` for a sha this clone lacks.
export const commitTree = (root, sha) => git(root, "rev-parse", "-q", "--verify", `${sha}^{tree}`)?.trim();

// Every recorded `{ tree, status: "passed" | "failed", suite: "verify" | "push", at, head?, failures? }`, newest first:
// the store's `verdict` entries, and what the verdicts' own file held before they moved there.
export const readVerdicts = (root) => {
    const legacy = legacyVerdictPath(root);
    return [...readStore(root).filter((entry) => entry.kind === "verdict"), ...(legacy === undefined ? [] : readArray(legacy))]
        .filter((verdict) => typeof verdict.tree === "string")
        .toSorted((left, right) => (right.at ?? 0) - (left.at ?? 0));
};

// The verdicts about any of `trees` that are young enough to trust, newest first.
export const freshVerdicts = (root, trees, now = Date.now()) => {
    const wanted = new Set([...trees].filter((tree) => tree !== undefined));
    return readVerdicts(root).filter((verdict) => wanted.has(verdict.tree) && now - verdict.at < VERDICT_TTL_MS);
};

// Puts one verdict at the head of the record, replacing an older one about the same tree and suite. `details` is `head`
// and, when red, failure-units' `verdictUnits`.
export const writeVerdict = (root, tree, status, suite, details = {}) => {
    if (tree === undefined) {
        return false;
    }
    const entry = { version: 1, kind: "verdict", tree, status, suite, at: Date.now(), ...details };
    return writeStore(root, entry, (each) => each.kind === "verdict" && each.tree === tree && each.suite === suite).ok;
};

export const ago = (at) => {
    const seconds = Math.round((Date.now() - at) / 1000);
    return seconds < 90 ? `${seconds}s ago` : `${Math.round(seconds / 60)} min ago`;
};
