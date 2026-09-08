import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { errorMessage } from "@intentic/base/errors";
import { repoRoot } from "@intentic/constants/node";

// Api and web images are built here from the release's own Dockerfiles, not pulled as `:latest`; both are COPY wrappers
// around a turbo-built tree, so this is a cheap cache replay. Built as images, not bind-mounted, since mounting this
// workspace's node_modules into a different base image breaks prisma's native engines.

const run = promisify(execFile);
const root = repoRoot(import.meta.url);

// Local-only tags, no registry host, so nothing here can be pushed, and `docker compose pull` skips them.
export const IMAGES = {
    api: `intentic-onboarding-api:local`,
    web: `intentic-onboarding-web:local`,
    upstream: `intentic-onboarding-upstream:local`,
} as const;

const exec = async (command: string, args: string[], cwd: string, what: string): Promise<void> => {
    try {
        // Timeout catches a hang, not a measurement; maxBuffer is raised since vite's output exceeds the 1MB default.
        await run(command, args, { cwd, timeout: 20 * 60_000, maxBuffer: 64 * 1024 * 1024 });
    } catch (cause) {
        const message = errorMessage(cause);
        throw new Error(`${what} failed: ${message}`, { cause });
    }
};

// Builds the images the shared world runs. `ONBOARDING_SKIP_IMAGE_BUILD=1` reuses what's already tagged, for iterating
// against an unchanged world; opt-in only, so the tier never silently tests yesterday's code.
export const buildImages = async (): Promise<void> => {
    if (process.env[`ONBOARDING_SKIP_IMAGE_BUILD`] === `1`) {
        return;
    }

    // No dependencies, no build step: the stand-in is the stock node base with two files copied in.
    await exec(
        `docker`,
        [`build`, `--provenance=false`, `-t`, IMAGES.upstream, `.`],
        join(root, `_tools/fake-upstream`),
        `building the stand-in model`,
    );

    // Workspace deps both apps COPY in; running it explicitly lets the builds below be pure COPYs.
    await exec(
        `pnpm`,
        [`turbo`, `run`, `build`, `--filter=@intentic/api`, `--filter=@intentic/web`],
        root,
        `building the platform's api and web bundles`,
    );

    // Api's context is a pruned, flat production install; `-f Dockerfile` since that tree carries its own copy.
    const apiDir = join(root, `_platform/api`);
    await rm(join(apiDir, `deploy`), { recursive: true, force: true });
    await exec(`pnpm`, [`--filter=@intentic/api`, `deploy`, `--prod`, `./deploy`], apiDir, `pruning the api's production tree`);
    await exec(`docker`, [`build`, `--provenance=false`, `-f`, `Dockerfile`, `-t`, IMAGES.api, `./deploy`], apiDir, `building the api image`);

    // The web's context is its own app dir; .dockerignore keeps only dist, the nginx template and the entrypoint.
    await exec(`docker`, [`build`, `--provenance=false`, `-t`, IMAGES.web, `.`], join(root, `_editor/web`), `building the web image`);
};
