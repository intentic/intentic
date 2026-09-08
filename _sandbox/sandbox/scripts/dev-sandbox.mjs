#!/usr/bin/env node
// intentic dev-sandbox watch loop: rebuilds the image or reloads the daemon as sandbox sources change. One-time setup:
// 1. `SANDBOX_IMAGE=intentic-sandbox:dev bash _site/site/public/scripts/connect.sh` builds the dev image, sets up
//    tunnel/auth.
// 2. `pnpm dev:sandbox` runs this script; leave it running.
import { spawn } from "node:child_process";
import { join, resolve, sep } from "node:path";
import { watch } from "chokidar";

const SCRIPT_DIR = import.meta.dirname;
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const DEBOUNCE_MS = 500;
// Which sandbox this loop drives, forwarded verbatim; empty means the one machine-local sandbox (auto-detected).
const SLUG_ARGS = process.argv.slice(2);

// Groups holding the daemon and its workspace deps; @intentic/constants lives in _tools, unlike the others.
const WATCH_PATHS = [join(REPO_ROOT, "_sandbox"), join(REPO_ROOT, "_deploy"), join(REPO_ROOT, "_search"), join(REPO_ROOT, "_tools/constants")];

// chokidar v4 dropped glob support; build artifacts and vcs dirs are filtered by path segment instead.
const IGNORED_SEGMENTS = new Set(["node_modules", "dist", ".turbo", ".cache", "generated", ".astro", ".git"]);
const ignored = (path) => path.split(sep).some((segment) => IGNORED_SEGMENTS.has(segment));

const run = (command, args) =>
    new Promise((resolvePromise) => {
        const child = spawn(command, args, { cwd: REPO_ROOT, stdio: "inherit" });
        child.on("exit", (code) => resolvePromise(code ?? 1));
    });

// Denylist of what the dev-mount can't carry; everything else reloads via mount, only these need a rebuild.
const IMAGE_ONLY_PATHS = [
    join(REPO_ROOT, "_sandbox/sandbox/Dockerfile"),
    join(REPO_ROOT, "_sandbox/sandbox/docker-entrypoint.sh"),
    // Feature-pack fragments the dev image splices in; image layers by definition.
    join(REPO_ROOT, "_sandbox/sandbox/image-packs"),
    // Copied to /usr/local/bin and /root/.claude/skills, outside any mounted dist.
    join(REPO_ROOT, "_sandbox/sandbox/bin"),
    join(REPO_ROOT, "_sandbox/sandbox/seed-skills"),
];

// A dependency change touches node_modules, which is never mounted; only an image rebuild can install it.
const isManifest = (path) => path.endsWith("package.json") || path.endsWith("pnpm-lock.yaml");

const needsImageRebuild = (path) => isManifest(path) || IMAGE_ONLY_PATHS.some((prefix) => path === prefix || path.startsWith(prefix + sep));

let building = false;
// Pending run's kind: undefined means nothing queued; one image-rebuild need promotes the whole batch.
let pending;
let queued;
let timer;

const cycle = async (fullRebuild) => {
    building = true;
    if (fullRebuild) {
        console.log("\nintentic: change detected, pnpm build:sandbox…");
        const buildCode = await run("pnpm", ["build:sandbox"]);
        if (buildCode === 0) {
            await run("bash", [join(SCRIPT_DIR, "dev-sandbox.sh"), ...SLUG_ARGS]);
        } else {
            console.error("intentic: build failed, the running sandbox is untouched. Fix the error and save again.");
        }
    } else {
        // Fast path: builds into the mounted dists and restarts the daemon; refuses on a container older than the
        // mounts.
        console.log("\nintentic: change detected, reloading the daemon…");
        await run("sh", [join(SCRIPT_DIR, "dev-reload.sh"), ...SLUG_ARGS]);
    }
    building = false;
    if (pending !== undefined) {
        const next = pending;
        pending = undefined;
        void cycle(next);
    }
};

const schedule = (path) => {
    const full = needsImageRebuild(path);
    if (building) {
        pending = (pending ?? false) || full;
        return;
    }
    queued = (queued ?? false) || full;
    clearTimeout(timer);
    timer = setTimeout(() => {
        const due = queued ?? false;
        queued = undefined;
        void cycle(due);
    }, DEBOUNCE_MS);
};

watch(WATCH_PATHS, { ignored, ignoreInitial: true }).on("all", (_event, path) => schedule(path));

console.log(
    `intentic: watching sandbox sources for ${SLUG_ARGS[0] ?? "this machine's sandbox"}, source edits reload in seconds; Dockerfile/bin/skills/deps rebuild the image. Ctrl-C to stop.`,
);
