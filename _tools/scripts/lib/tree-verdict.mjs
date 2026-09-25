// Caches pass/fail verdicts against a hash of a tree's content (`git write-tree` over index+add -A), so identical content
// is not re-measured. Stored in the common git dir (`intentic-push-verified`), shared across worktrees, the newest
// VERDICTS_KEPT entries; `pnpm verify` writes a `verify` verdict, verify-push.mjs writes `push` and reads both, matching
// the working tree or any pushed commit's own tree.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { git } from "./git.mjs";

// A verdict older than this is re-measured even for an identical tree: node_modules is not in the hash.
export const VERDICT_TTL_MS = 12 * 60 * 60_000;
// A day of lands, each writing one `verify` verdict green or red, plus the pushes between them.
export const VERDICTS_KEPT = 40;
// How far back along the main line a `verify` verdict still stands in for a base nobody measured exactly.
export const BASE_DISTANCE_MAX = 20;

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

const verdictPath = (root) => {
    const dir = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")?.trim();
    return dir === undefined ? undefined : join(dir, "intentic-push-verified");
};

// Every recorded `{ tree, status: "passed" | "failed", suite: "verify" | "push", at, head?, failures? }`, newest first.
export const readVerdicts = (root) => {
    const path = verdictPath(root);
    if (path === undefined) {
        return [];
    }
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        return Array.isArray(parsed) ? parsed.filter((verdict) => typeof verdict?.tree === "string") : [];
    } catch {
        return [];
    }
};

// The verdicts about any of `trees` that are young enough to trust, newest first.
export const freshVerdicts = (root, trees, now = Date.now()) => {
    const wanted = new Set([...trees].filter((tree) => tree !== undefined));
    return readVerdicts(root).filter((verdict) => wanted.has(verdict.tree) && now - verdict.at < VERDICT_TTL_MS);
};

// Puts one verdict at the head of the record, replacing an older one about the same tree and suite.
const recordVerdict = (root, entry) => {
    const path = verdictPath(root);
    if (path === undefined) {
        return false;
    }
    const kept = readVerdicts(root).filter((verdict) => !(verdict.tree === entry.tree && verdict.suite === entry.suite));
    try {
        writeFileSync(path, `${JSON.stringify([entry, ...kept].slice(0, VERDICTS_KEPT))}\n`);
        return true;
    } catch {
        return false;
    }
};

// Replaces an older verdict about the same tree and suite; `details` is `head` and, when red, failure-units' `verdictUnits`.
// A run offloaded to a runner (INTENTIC_VERDICT_OUT set, bin/offload-run) also leaves the verdict there, for the tree it
// came from to merge into its own record: the runner's git dir is not the one the push reads.
export const writeVerdict = (root, tree, status, suite, details = {}) => {
    if (tree === undefined) {
        return false;
    }
    const entry = { tree, status, suite, at: Date.now(), ...details };
    const out = process.env.INTENTIC_VERDICT_OUT;
    if (out !== undefined && out !== "") {
        try {
            writeFileSync(out, `${JSON.stringify(entry)}\n`);
        } catch {
            // silent-catch: the verdict still lands in this tree's own record below; only the copy is lost
        }
    }
    return recordVerdict(root, entry);
};

// `node tree-verdict.mjs merge <file>`: records a verdict an offloaded run brought back (see writeVerdict), in the
// repository the command stands in.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === "merge") {
    const entry = JSON.parse(readFileSync(process.argv[3] ?? "", "utf8"));
    if (typeof entry?.tree !== "string" || typeof entry?.suite !== "string") {
        process.stderr.write("tree-verdict: that file holds no verdict\n");
        process.exit(1);
    }
    process.exit(recordVerdict(process.cwd(), entry) ? 0 : 1);
}

// The `verify` verdict about `base`'s tree, else its nearest measured ancestor within BASE_DISTANCE_MAX commits.
export const verdictForBase = (root, base) => {
    const tree = commitTree(root, base);
    const verifies = readVerdicts(root).filter((verdict) => verdict.suite === "verify");
    const exact = verifies.find((verdict) => verdict.tree === tree);
    if (exact !== undefined) {
        return { verdict: exact, distance: 0 };
    }
    let nearest;
    for (const verdict of verifies) {
        if (typeof verdict.head !== "string" || spawnSync("git", ["merge-base", "--is-ancestor", verdict.head, base], { cwd: root }).status !== 0) {
            continue;
        }
        const distance = Number(git(root, "rev-list", "--count", `${verdict.head}..${base}`)?.trim());
        if (Number.isInteger(distance) && distance <= BASE_DISTANCE_MAX && (nearest === undefined || distance < nearest.distance)) {
            nearest = { verdict, distance };
        }
    }
    return nearest;
};

export const ago = (at) => {
    const seconds = Math.round((Date.now() - at) / 1000);
    return seconds < 90 ? `${seconds}s ago` : `${Math.round(seconds / 60)} min ago`;
};
