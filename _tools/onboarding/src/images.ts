import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { repoRoot } from "@intentic/constants/node";

/* THE IMAGES THIS TIER RUNS, BUILT FROM THE BRANCH, not pulled as `:latest`.
 *
 * A gate that tests the last release is not a gate. So the api and the web SPA are built here from exactly the
 * same two Dockerfiles the release uses, with the push left off. That costs almost nothing to do honestly:
 * both files are pure `COPY` wrappers around a tree turbo has already built, so after any job that ran
 * `verify-platform` this is a cache replay and two short docker builds.
 *
 * It is a local image build rather than a bind-mount of the repository for one reason worth stating: mounting
 * this workspace's `node_modules` into a different base image is how prisma's native engines start failing for
 * reasons nobody can read, and the api's start-up runs prisma. The Dockerfiles already know how to assemble a
 * tree that works; borrowing them is cheaper than rediscovering why.
 */

const run = promisify(execFile);
const root = repoRoot(import.meta.url);

// Local-only tags. No registry host, so nothing here can be pushed by accident and a `docker compose pull`
// anywhere near this run skips them rather than asking Docker Hub for something that does not exist.
export const IMAGES = {
    api: `intentic-onboarding-api:local`,
    web: `intentic-onboarding-web:local`,
    upstream: `intentic-onboarding-upstream:local`,
    zrok: `intentic-onboarding-zrok:local`,
} as const;

const exec = async (command: string, args: string[], cwd: string, what: string): Promise<void> => {
    try {
        // 20 minutes: a cold turbo cache builds the whole SPA here, and the ceiling exists to catch a hang
        // rather than to measure a build. maxBuffer because vite is chatty and the default 1 MB truncates.
        await run(command, args, { cwd, timeout: 20 * 60_000, maxBuffer: 64 * 1024 * 1024 });
    } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`${what} failed — ${message}`, { cause });
    }
};

/* Build the three images the shared world runs.
 *
 * `ONBOARDING_SKIP_IMAGE_BUILD=1` reuses whatever is already tagged. That is for iterating on a spec against a
 * world that has not changed; it is deliberately an opt-in, because a tier that skipped the build by default
 * would be a tier that silently tested yesterday's code.
 */
export const buildImages = async (): Promise<void> => {
    if (process.env[`ONBOARDING_SKIP_IMAGE_BUILD`] === `1`) {
        return;
    }

    // No dependencies, no build step, each stand-in is the stock node base with two files copied in.
    await exec(
        `docker`,
        [`build`, `--provenance=false`, `-t`, IMAGES.upstream, `.`],
        join(root, `_tools/fake-upstream`),
        `building the stand-in model`,
    );
    await exec(`docker`, [`build`, `--provenance=false`, `-t`, IMAGES.zrok, `.`], join(root, `_tools/fake-zrok`), `building the stand-in tunnel hub`);

    // The workspace deps both apps COPY in. `docker:release` declares this as its `dependsOn`; running it
    // explicitly is what lets the two builds below be pure COPYs of a tree that already exists.
    await exec(
        `pnpm`,
        [`turbo`, `run`, `build`, `--filter=@intentic-app/api`, `--filter=@intentic-app/web`],
        root,
        `building the platform's api and web bundles`,
    );

    /* The api's context is a PRUNED tree, a flat, symlink-free production install that the Dockerfile copies
     * whole. `-f Dockerfile` is explicit because that tree carries its own copy of it. */
    const apiDir = join(root, `_platform/api`);
    await rm(join(apiDir, `deploy`), { recursive: true, force: true });
    await exec(`pnpm`, [`--filter=@intentic-app/api`, `deploy`, `--prod`, `./deploy`], apiDir, `pruning the api's production tree`);
    await exec(`docker`, [`build`, `--provenance=false`, `-f`, `Dockerfile`, `-t`, IMAGES.api, `./deploy`], apiDir, `building the api image`);

    // The web's context is its own app dir; .dockerignore keeps only dist, the nginx template and the entrypoint.
    await exec(`docker`, [`build`, `--provenance=false`, `-t`, IMAGES.web, `.`], join(root, `_editor/web`), `building the web image`);
};
