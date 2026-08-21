import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot as findPackageRoot, repoRoot as findRepoRoot } from "@intentic/constants/node";
import { createEngine, type IndexStatus } from "@intentic/iq-engine";
import { type RepoLock, ReposLockSchema } from "./schema.js";

export const packageRoot = findPackageRoot(import.meta.url);
// The monorepo checkout doubles as the "intentic" benchmark repo, no clone step.
export const monorepoRoot = findRepoRoot(import.meta.url);
export const cacheDir = join(packageRoot, ".cache");

const readReposLock = (): RepoLock[] => ReposLockSchema.parse(JSON.parse(readFileSync(join(packageRoot, "datasets/repos.lock.json"), "utf8")));

// Clone pinned at the locked sha, idempotent: a second call with an unchanged lock is a no-op.
const materialize = (repo: RepoLock): string => {
    const dir = join(cacheDir, "repos", repo.id);
    if (existsSync(join(dir, ".git"))) {
        const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
        if (head === repo.sha) {
            return dir;
        }
    } else {
        mkdirSync(dir, { recursive: true });
        execFileSync("git", ["init", "-q", dir]);
    }
    execFileSync("git", ["-C", dir, "fetch", "-q", "--depth", "1", repo.url, repo.sha]);
    execFileSync("git", ["-C", dir, "checkout", "-q", "--detach", repo.sha]);
    return dir;
};

export const repoRoot = (repoId: string): string => {
    if (repoId === "intentic") {
        return monorepoRoot;
    }
    const lock = readReposLock().find((repo) => repo.id === repoId);
    if (lock === undefined) {
        throw new Error(`iq-bench: repo "${repoId}" not in datasets/repos.lock.json`);
    }
    return materialize(lock);
};

export const headSha = (root: string): string => execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

// Embedding + reranker models (~57 MB), fetched once into .cache/models via iq-engine's own script.
// Returns undefined when absent and unfetchable, semantic/rerank configs are then reported as skipped.
export const ensureModels = (): string | undefined => {
    const dir = process.env["IQ_MODEL_DIR"] ?? join(cacheDir, "models");
    if (existsSync(dir)) {
        return dir;
    }
    const script = join(monorepoRoot, "_search/iq-engine/scripts/fetch-model.mjs");
    try {
        execSync(`node ${script} ${dir}`, { stdio: "inherit" });
        return dir;
    } catch {
        console.warn("iq-bench: model fetch failed, semantic/rerank configs will be skipped");
        return undefined;
    }
};

// Index lives under the bench's .cache (not the repo's .intentic/local/cache/iq) so working trees stay pristine.
export const indexDirFor = (repoId: string): string => join(cacheDir, "index", repoId);

export const ensureIndex = async (repoId: string, root: string, models: string | undefined): Promise<{ status: IndexStatus; buildMs?: number }> => {
    const indexDir = indexDirFor(repoId);
    const engine = createEngine({ root, indexDir, ...(models !== undefined ? { modelDir: models } : {}) });
    if (existsSync(indexDir)) {
        const status = await engine.indexStatus();
        // Complete embeddings are part of the benchmark contract, a lazily half-embedded index is not.
        if (models === undefined || status.embedded >= status.chunks) {
            return { status };
        }
    }
    const start = Date.now();
    const status = await engine.indexRebuild();
    return { status, buildMs: Date.now() - start };
};
