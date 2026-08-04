#!/usr/bin/env node
// intentic dev-sandbox watch loop — the automated inner loop for testing sandbox changes in docker.
//
// One-time setup (done by hand):
//   1. SANDBOX_IMAGE=intentic-sandbox:dev bash _apps/site/public/scripts/connect.sh   (builds the dev image if missing; establishes tunnel + auth once)
//   2. pnpm dev:sandbox                                                               (this script — leave it running)
//
// `pnpm dev:sandbox <slug>` watches for the NAMED sandbox — the slug rides through to both swap paths below.
// Without one they detect the single sandbox on this machine and refuse to guess between several, so a machine
// running two of them (a branch beside main) needs the slug or the loop stops at every rebuild.
//
// Then every edit under the watched paths rebuilds intentic-sandbox:dev and recreates the running
// sandbox container against its existing tunnel/auth/volumes (the sibling dev-sandbox.sh). The daemon is
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

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../..");
const DEBOUNCE_MS = 500;
// Which sandbox this loop drives, forwarded verbatim to both swap scripts. Empty means "the one on this
// machine", which is what they detect for themselves.
const SLUG_ARGS = process.argv.slice(2);

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

// Which path a change needs. The container bind-mounts every compiled tree from the working tree
// (dev-mounts.mjs), so anything that ends up as JavaScript in one of those dists reloads with a build + restart;
// everything else is baked into an image layer and needs the full rebuild.
//
// The list is deliberately a denylist of what the mounts CANNOT carry, not an allowlist of TypeScript: a new
// kind of source file should reload fast by default, whereas forgetting to list a new baked artifact here would
// leave the container running stale code — the failure this whole loop exists to prevent.
const IMAGE_ONLY_PATHS = [
    join(REPO_ROOT, "_apps/sandbox/Dockerfile"),
    join(REPO_ROOT, "_apps/sandbox/docker-entrypoint.sh"),
    // Copied to /usr/local/bin and /root/.claude/skills, outside any mounted dist.
    join(REPO_ROOT, "_apps/sandbox/bin"),
    join(REPO_ROOT, "_apps/sandbox/skills"),
];

// A dependency change alters node_modules, which is never mounted (the image keeps its own installed tree,
// including native builds); only a real image rebuild can install it.
const isManifest = (path) => path.endsWith("package.json") || path.endsWith("pnpm-lock.yaml");

const needsImageRebuild = (path) => isManifest(path) || IMAGE_ONLY_PATHS.some((prefix) => path === prefix || path.startsWith(prefix + sep));

let building = false;
// The pending run's kind: `undefined` when nothing is queued, otherwise whether a full rebuild is required.
// Changes coalesce upward — if anything in the batch needs an image rebuild, the whole batch gets one.
let pending;
let queued;
let timer;

const cycle = async (fullRebuild) => {
    building = true;
    if (fullRebuild) {
        console.log("\nintentic: change detected — pnpm build:sandbox…");
        const buildCode = await run("pnpm", ["build:sandbox"]);
        if (buildCode === 0) {
            await run("bash", [join(SCRIPT_DIR, "dev-sandbox.sh"), ...SLUG_ARGS]);
        } else {
            console.error("intentic: build failed — the running sandbox is untouched. Fix the error and save again.");
        }
    } else {
        // The fast path: compile into the mounted dists and restart the daemon in place. It refuses (with an
        // explanation) if this container predates the mounts, so a stale run can't masquerade as a reload.
        console.log("\nintentic: change detected — reloading the daemon…");
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
    `intentic: watching sandbox sources for ${SLUG_ARGS[0] ?? "this machine's sandbox"} — source edits reload in seconds; Dockerfile/bin/skills/deps rebuild the image. Ctrl-C to stop.`,
);
