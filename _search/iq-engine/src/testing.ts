import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { STATE_DIR } from "@intentic/constants";
import { packageRoot } from "@intentic/constants/node";

const exec = promisify(execFile);

const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: "fixture-author",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "fixture-author",
    GIT_COMMITTER_EMAIL: "fixture@example.com",
};

// Copies the committed fixture workspace into a tmp dir and adds what must never be committed: security-floor
// decoys (a fake .env, index-dir contents) and a REAL git repo in alpha (with a token-bearing
// remote URL, so floor tests can assert .git content never surfaces). Every "denied" path exists on disk.
export const makeFixtureWorkspace = async (): Promise<{ root: string; cleanup: () => Promise<void> }> => {
    const root = await mkdtemp(join(tmpdir(), "iq-fixture-"));
    // Anchored to the package root, so it resolves from dist/testing.js and src/testing.ts alike (fixtures are
    // never compiled) without either layout's depth being part of the answer.
    await cp(join(packageRoot(import.meta.url), "src/__fixtures__/workspace"), root, { recursive: true });
    await writeFile(join(root, ".env"), "FIXTURE_SECRET_TOKEN=fixture-secret-value\n");
    await writeFile(join(root, ".env.example"), "FIXTURE_SECRET_TOKEN=\n");
    await mkdir(join(root, `${STATE_DIR}/local/cache/iq/spool`), { recursive: true });
    await writeFile(join(root, `${STATE_DIR}/local/cache/iq/decoy.txt`), "index dir contents must never be surfaced\n");
    const alpha = join(root, "alpha");
    // The .gitignore'd build artifact, synthesized (alpha's own .gitignore keeps it out of THIS repo too, so it
    // can't ship as a committed fixture file). Written before `git add` so the fixture repo also ignores it.
    await mkdir(join(alpha, "dist"), { recursive: true });
    await writeFile(join(alpha, "dist/decoy.js"), "export const IGNORED_BUILD_ARTIFACT = true;\n");
    await exec("git", ["-C", alpha, "init", "-q"], { env: GIT_ENV });
    await exec("git", ["-C", alpha, "remote", "add", "origin", "https://token@example.com/repo.git"], { env: GIT_ENV });
    await exec("git", ["-C", alpha, "add", "-A"], { env: GIT_ENV });
    await exec("git", ["-C", alpha, "commit", "-q", "-m", "add widget module"], { env: GIT_ENV });
    return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
};
