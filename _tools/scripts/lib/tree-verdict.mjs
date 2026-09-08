// Caches a pass/fail verdict against a hash of the working tree's content (`git write-tree` over index+add -A), so
// identical content is not re-measured. Stored in the common git dir (`intentic-push-verified`), shared across
// worktrees; `pnpm verify` writes a `verify` verdict, verify-push.mjs writes `push` and reads both.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { git } from "./git.mjs";

// A verdict older than this is re-measured even for an identical tree: node_modules is not in the hash.
export const VERDICT_TTL_MS = 12 * 60 * 60_000;

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

const verdictPath = (root) => {
    const dir = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")?.trim();
    return dir === undefined ? undefined : join(dir, "intentic-push-verified");
};

// `{ tree, status: "passed" | "failed", suite: "verify" | "push", at }`, or undefined when none was recorded.
export const readVerdict = (root) => {
    const path = verdictPath(root);
    if (path === undefined) {
        return undefined;
    }
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
};

// Whether a verdict is about this exact tree and young enough to trust.
export const freshFor = (verdict, tree) => verdict !== undefined && tree !== undefined && verdict.tree === tree && Date.now() - verdict.at < VERDICT_TTL_MS;

export const writeVerdict = (root, tree, status, suite) => {
    const path = verdictPath(root);
    if (path === undefined || tree === undefined) {
        return false;
    }
    try {
        writeFileSync(path, `${JSON.stringify({ tree, status, suite, at: Date.now() })}\n`);
        return true;
    } catch {
        return false;
    }
};

export const ago = (at) => {
    const seconds = Math.round((Date.now() - at) / 1000);
    return seconds < 90 ? `${seconds}s ago` : `${Math.round(seconds / 60)} min ago`;
};
