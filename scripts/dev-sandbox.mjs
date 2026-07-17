#!/usr/bin/env node
// intentic dev-sandbox watch loop — the automated inner loop for testing sandbox changes in docker.
//
// One-time setup (done by hand):
//   1. pnpm build:sandbox
//   2. SANDBOX_IMAGE=intentic-sandbox:dev bash scripts/connect.sh   (establishes tunnel + auth once)
//   3. pnpm dev:sandbox                                             (this script — leave it running)
//
// Then every edit under the watched paths rebuilds intentic-sandbox:dev and recreates the running
// sandbox container against its existing tunnel/auth/volumes (scripts/dev-sandbox.sh). The daemon is
// baked into the image (Dockerfile COPY --from=build /out/sandbox), so a rebuild is the only way a
// running container reflects a source change — there is no bind-mount of dist to hot-reload.
//
// Rebuilds are DEBOUNCED and SERIALIZED: two never run at once, and edits that land mid-build are
// coalesced into exactly one follow-up run. A failed `pnpm build:sandbox` leaves the running
// container untouched (we only recreate on a clean build).
//
// Scope note: this watches all of _libs, not just the sandbox's own workspace deps — a change to any
// shared lib triggers a full image rebuild. That's intentional under the "auto-rebuild whole image"
// model (the sandbox bundles several @intentic/* libs, and over-rebuilding is safe, just slower).
import { spawn } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { watch } from "chokidar";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEBOUNCE_MS = 500;

const WATCH_PATHS = [
    join(REPO_ROOT, "_apps/sandbox/src"),
    join(REPO_ROOT, "_apps/sandbox/bin"),
    join(REPO_ROOT, "_apps/sandbox/skills"),
    join(REPO_ROOT, "_apps/sandbox/Dockerfile"),
    join(REPO_ROOT, "_apps/sandbox/docker-entrypoint.sh"),
    join(REPO_ROOT, "_libs"),
];

// chokidar v4 dropped glob support, so we watch dirs and filter build artifacts / vcs dirs by segment.
const IGNORED_SEGMENTS = new Set(["node_modules", "dist", ".turbo", ".cache", "generated", ".astro", ".git"]);
const ignored = (path) => path.split(sep).some((segment) => IGNORED_SEGMENTS.has(segment));

const run = (command, args) =>
    new Promise((resolvePromise) => {
        const child = spawn(command, args, { cwd: REPO_ROOT, stdio: "inherit" });
        child.on("exit", (code) => resolvePromise(code ?? 1));
    });

let building = false;
let pending = false;
let timer;

const cycle = async () => {
    building = true;
    console.log("\nintentic: change detected — pnpm build:sandbox…");
    const buildCode = await run("pnpm", ["build:sandbox"]);
    if (buildCode === 0) {
        await run("bash", [join(REPO_ROOT, "scripts/dev-sandbox.sh")]);
    } else {
        console.error("intentic: build failed — the running sandbox is untouched. Fix the error and save again.");
    }
    building = false;
    if (pending) {
        pending = false;
        void cycle();
    }
};

const schedule = () => {
    if (building) {
        pending = true;
        return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => void cycle(), DEBOUNCE_MS);
};

watch(WATCH_PATHS, { ignored, ignoreInitial: true }).on("all", schedule);

console.log("intentic: watching sandbox sources — edit and save to rebuild. Ctrl-C to stop.");
