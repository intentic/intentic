import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { sessionsDir } from "../../sessions/session-store.js";
import { MIRRORED_DIRS } from "@intentic/constants/mirror-roots";
import { type Fence, fenceAllows, fenceReaches, foldPath } from "@intentic/sandbox-contract";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { walkDirs } from "../../workspace/layout/dir-walk.js";
import type { Logger } from "pino";
import { promisify } from "node:util";
import { detachedStamp } from "../../seams/workload-stamp.js";
import { SHARED_STATE } from "../../workload/worktree-paths.js";
import { type SandboxLayout, sandboxAvailable, startSandboxAnchor } from "./turn-sandbox.js";

// An isolated turn's own view of /work: without this, an absolute path (a memory, an AGENTS.md, a message) named the
// shared tree directly, bypassing `land` and losing attribution. A mount namespace makes the worktree BE /work; shared
// state and dependency mirrors are bound back in, everything else is private and dies with the turn.

const execFileAsync = promisify(execFile);

// Stable path to the real workspace root inside the namespace, for a turn that genuinely needs the shared tree.
// Unmounted again for a fenced turn: it is the whole workspace, which is what that turn's checkout was cut down from.
export const MAIN_MOUNT = "/mnt/intentic-main";

// Reference repos cloned only to be read against; workspace content, not repo content, so a worktree needs it mounted
// back in or hits ENOENT. Read-only by contract: a bind ignores `ro`, so the remount is a second step.
const SHELF = "refs";

// pnpm's package store, which pnpm keeps at the top of the mount a project sits on: `/work/.pnpm-store` for every
// project in the tree. Inside a namespace that path is the worktree's own, so each conversation's first install would
// download everything again into a store of its own. Bound back from the main tree: the store is content-addressed and
// pnpm shares one between concurrent installs by design, and the path an overlaid `node_modules` names in its
// `.modules.yaml` stays the one pnpm finds. The tree is private; the cache is not. Conditional like the shelf: a
// workspace nobody ran pnpm in has none, and the worktree keeps its own then.
export const PACKAGE_STORE = ".pnpm-store";

// Deps and build output a checkout can't carry (MIRRORED_DIRS); caches excluded, a stale tsbuildinfo would falsely
// agree with the mirror. Each name is a live overlay's lowerdir: empty it, never replace it.

// Same depth bound as the symlink mirroring this replaces.
const MAX_LINK_DEPTH = 3;

// What a fenced conversation's sandbox needs beyond the shared plan (turn-sandbox.ts builds it). Every piece is derived
// from the fence itself, never from what the checkout happens to hold: the sparse checkout (worktree-cone.ts) is what
// keeps the rest off disk, and the sandbox is what keeps it out of reach when the checkout holds more than it should.
export interface FencedPlacement {
    // The fence, as workspace-relative folders: what decides which mirrors and which of the shelf the sandbox carries.
    readonly folders: readonly string[];
    // Directories the checkout holds that the fence neither admits nor leads to (hiddenIn), each covered by an empty
    // layer: untracked work left in a folder an area since dropped, or a checkout that failed to narrow.
    readonly hidden: readonly string[];
    // This conversation's own runtime session store, bound over the shared one: transcripts, plans and backups it
    // writes must not land where another conversation's turn can read them, nor read what another wrote.
    readonly sessions: string;
    // Worktree-relative directories holding a repository's `.git` pointer ("" is the root): each is masked, since the
    // repository behind it holds every folder's history, not just the fence's.
    readonly gitPointers: readonly string[];
}

export interface IsolationPlan {
    // The conversation's root-repo worktree; what /work becomes.
    readonly worktree: string;
    // The real workspace root, bound aside at MAIN_MOUNT.
    readonly root: string;
    // Root-relative dirs mirrored from the main checkout; shallowest-first so a parent can't shadow a child.
    readonly mirrors: readonly string[];
    // Where this conversation's overlay layers live, outside the worktree so installs don't show in `git status`.
    readonly overlays: string;
    // Absent for a conversation that may see the whole workspace, which needs none of it.
    readonly fence: FencedPlacement | undefined;
}

// One path derivation shared by the daemon (which creates and reclaims these) and the plan, so there is no second
// convention to drift from this one.
export const overlaysRoot = (historyRoot: string): string => join(historyRoot, "overlays");
export const overlaysDir = (historyRoot: string, id: string): string => join(overlaysRoot(historyRoot), id);

// A bind kept one st_dev, letting pnpm hardlink installs into tracked files; an overlay copies-up on first write
// instead, and a cross-device hardlink throws EXDEV.
// Shown by `mount`/`df`; named for what it is rather than another anonymous `overlay` row.
const OVERLAY_FS_NAME = "intentic-modules";


// Overlay options are one comma-separated word; the kernel splits on `,`/`:` with no escaping. Refuses a path
// containing either, so a collision fails loudly (`set -e`) instead of silently mounting the wrong thing.
const overlayOptions = (lower: string, upper: string, work: string): string => {
    for (const path of [lower, upper, work]) {
        if (path.includes(",") || path.includes(":")) {
            throw new Error(`turn isolation: overlay path cannot contain "," or ":", ${path}`);
        }
    }
    return `lowerdir=${lower},upperdir=${upper},workdir=${work}`;
};

// Wrapping the agent directly fails: its Bash tool forks tmux panes off the daemon's long-lived server, keeping the
// daemon's mounts. One anchor builds the namespace once; the agent and every pane join it by pid.

// Ordering is the whole argument: rprivate first, the root bound aside before the worktree shadows it, then shared
// state and mirrors from MAIN_MOUNT. Every step is fatal (`set -e`); a half-built namespace is worse than none.
export const isolationScript = (plan: IsolationPlan, trailer: string = ANCHOR_TRAILER): string => {
    const lines = [
        `set -e`,
        `mount --make-rprivate /`,
        `mkdir -p ${shellQuote(MAIN_MOUNT)}`,
        `mount --bind ${shellQuote(plan.root)} ${shellQuote(MAIN_MOUNT)}`,
        `mount --bind ${shellQuote(plan.worktree)} ${shellQuote(plan.root)}`,
    ];
    for (const rel of SHARED_STATE) {
        const source = join(MAIN_MOUNT, rel);
        const target = join(plan.root, rel);
        lines.push(`mkdir -p ${shellQuote(source)} ${shellQuote(target)}`, `mount --bind ${shellQuote(source)} ${shellQuote(target)}`);
    }
    // Conditional, not plan-driven: most workspaces have no shelf, and `set -e` must not die over its absence.
    const shelf = join(plan.root, SHELF);
    lines.push(
        `if [ -d ${shellQuote(join(MAIN_MOUNT, SHELF))} ]; then mkdir -p ${shellQuote(shelf)}; mount --bind ${shellQuote(join(MAIN_MOUNT, SHELF))} ${shellQuote(shelf)}; mount -o remount,bind,ro ${shellQuote(shelf)}; fi`,
    );
    const packageStore = join(plan.root, PACKAGE_STORE);
    lines.push(
        `if [ -d ${shellQuote(join(MAIN_MOUNT, PACKAGE_STORE))} ]; then mkdir -p ${shellQuote(packageStore)}; mount --bind ${shellQuote(join(MAIN_MOUNT, PACKAGE_STORE))} ${shellQuote(packageStore)}; fi`,
    );
    for (const rel of plan.mirrors) {
        const target = join(plan.root, rel);
        // Upper/work must be siblings on one filesystem; the mirror's path is encoded so nested dirs can't collide.
        const layer = join(plan.overlays, encodeURIComponent(rel));
        const upper = join(layer, "upper");
        const work = join(layer, "work");
        lines.push(
            `mkdir -p ${shellQuote(target)} ${shellQuote(upper)} ${shellQuote(work)}`,
            `mount -t overlay ${OVERLAY_FS_NAME} -o ${shellQuote(overlayOptions(join(MAIN_MOUNT, rel), upper, work))} ${shellQuote(target)}`,
        );
    }
    lines.push(trailer);
    return lines.join("\n");
};

// One stdout line to signal readiness, then a no-op process to keep the namespace inhabited; `exec`, so the sleep is
// the anchor's own pid.
export const ANCHOR_READY = "isolation-ready";
const ANCHOR_TRAILER = `echo ${ANCHOR_READY}\nexec sleep infinity`;

// How a process enters an anchor's namespace lives with the rest of process launching, so a runtime can start one
// there without importing this module (workload/namespace-entry.ts); named here too, where its callers look.
export { nsenterArgv, nsenterPrefix } from "../../workload/namespace-entry.js";

// A tmux client with no server forks one, keeping its mounts for life; inside a turn's namespace every future pane
// would inherit that worktree forever. The daemon hands its own namespace to the wrapper instead.
export const TMUX_NS_ENV = "INTENTIC_TMUX_NS";
export const daemonMountNs = `/proc/${process.pid}/ns/mnt`;

// Three probes: unshare/mount need CAP_SYS_ADMIN, overlayfs is its own kernel gate needing the history volume, and
// nsenter --wdns needs util-linux 2.38+. Missing any degrades instead of failing turns one at a time.
const probeScript = (dir: string): string =>
    [
        `set -e`,
        `mount -t overlay ${OVERLAY_FS_NAME} -o ${shellQuote(overlayOptions(join(dir, "lower"), join(dir, "upper"), join(dir, "work")))} ${shellQuote(join(dir, "merged"))}`,
    ].join("\n");

const isolationAvailable = async (historyRoot: string): Promise<boolean> => {
    const dir = join(historyRoot, ".isolation-probe");
    try {
        await rm(dir, { recursive: true, force: true });
        for (const part of ["lower", "upper", "work", "merged"]) {
            await mkdir(join(dir, part), { recursive: true });
        }
        await execFileAsync("unshare", ["--mount", "--propagation", "private", "sh", "-c", probeScript(dir)], { timeout: 5_000 });
        // Against the daemon's own namespace; `true` just needs `--wdns` to be accepted, which is the whole question.
        await execFileAsync("nsenter", [`--mount=${daemonMountNs}`, `--wdns=/`, "--", "true"], { timeout: 5_000 });
        return true;
    } catch {
        return false;
    } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
};

// A mirror is only correct where the worktree has nothing of its own; mounting a tracked `dist` over it would hide
// files the branch exists to change. Empty or absent means nothing of its own; anything else is hands off.
const mirrorable = async (path: string): Promise<boolean> => {
    const entry = await lstat(path).catch(() => undefined);
    if (entry === undefined || entry.isSymbolicLink()) {
        return true;
    }
    return entry.isDirectory() && (await readdir(path)).length === 0;
};

// One discovery shared by overlays and symlinks, so a dir mirrored by one form and not the other never means different
// files. `intoNestedRepos` differs: the plan wants every repo's dirs, the symlink mirror stops at a nested `.git`.
export const mirroredDirs = async (main: string, worktree: string, { intoNestedRepos }: { readonly intoNestedRepos: boolean }): Promise<string[]> => {
    const found: string[] = [];
    await walkDirs(main, { maxDepth: MAX_LINK_DEPTH }, async (dir, entries, subdirs) => {
        if (!intoNestedRepos && dir.rel !== "" && entries.some((entry) => entry.name === ".git")) {
            return [];
        }
        await Promise.all(
            entries
                .filter((entry) => entry.isDirectory() && MIRRORED_DIRS.has(entry.name))
                .map(async (entry) => {
                    const mirror = dir.rel === "" ? entry.name : `${dir.rel}/${entry.name}`;
                    if (await mirrorable(join(worktree, mirror))) {
                        found.push(mirror);
                    }
                }),
        );
        // A mirror's own contents are never mirror points; walking an installed tree would cost thousands of readdirs.
        return subdirs.filter((subdir) => !MIRRORED_DIRS.has(subdir.name));
    });
    // Shallowest first, so a parent is never mounted after a child already sits inside it.
    return found.toSorted((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1));
};

// The mapping (`plan`, always present) and whether it's enforced (`anchor`, only when the namespace could be built).
// Carried together so 'isolated but unenforced' is a state the code can see, not one it infers.
export interface TurnPlacement {
    readonly plan: IsolationPlan;
    readonly anchor?: IsolationAnchor;
}

export interface IsolationAnchor {
    // The pid holding the namespace open; what every entrant joins via nsenter.
    readonly pid: number;
    // The workspace root as the namespace sees it; where entrants start.
    readonly cwd: string;
    // What was mounted; every daemon-side reader needs it to translate an agent's paths back.
    readonly plan: IsolationPlan;
    // A fenced turn's sandbox (turn-sandbox.ts): its own temp dir, tmux socket and terminal logs, which the turn's env
    // and the Bash tool's rewrite must point at. Absent for an unfenced turn's plain mount namespace.
    readonly sandbox?: SandboxLayout;
    // Drops the anchor; anything still running inside keeps the namespace alive until it exits.
    readonly dispose: () => void;
}

// Resolves only once the mounts are actually up, so no caller can hand work to a half-built namespace. Rejects rather
// than degrading: the capability was already probed, so a failure here is a real fault.
// A fenced plan gets a sandbox instead (turn-sandbox.ts): a mount namespace its own root process could rearrange is no
// fence for a conversation whose person holds only some of the workspace.
export const startAnchor = async (plan: IsolationPlan): Promise<IsolationAnchor> => {
    const fence = plan.fence;
    if (fence !== undefined) {
        return startSandboxAnchor({ ...plan, fence });
    }
    const child = spawn("unshare", ["--mount", "--propagation", "private", "sh", "-c", isolationScript(plan)], {
        // Stamped, since its own group puts it out of netd's reach when the daemon dies: the next boot ends it
        // (system/boot/generation-sweep.ts), which no turn needs once the daemon that ran it is gone.
        env: { ...process.env, ...detachedStamp("isolation-anchor") },
        stdio: ["ignore", "pipe", "pipe"],
        // Own process group, so killing the anchor never takes down a pane the agent left running.
        detached: true,
    });
    const pid = child.pid;
    if (pid === undefined) {
        throw new Error("turn isolation: could not spawn the namespace anchor");
    }
    const dispose = (): void => {
        child.kill("SIGKILL");
    };
    try {
        await new Promise<void>((resolve, reject) => {
            let out = "";
            let errors = "";
            child.stdout.on("data", (chunk: Buffer) => {
                out += chunk.toString();
                if (out.includes(ANCHOR_READY)) {
                    resolve();
                }
            });
            child.stderr.on("data", (chunk: Buffer) => {
                errors += chunk.toString();
            });
            // A failed mount kills the whole script (`set -e`); the exit is the error, stderr says which mount.
            child.on("exit", (code: number | null) => reject(new Error(`turn isolation: namespace setup exited ${String(code)}: ${errors.trim()}`)));
            child.on("error", reject);
        });
    } catch (error) {
        dispose();
        throw error;
    }
    // The turn's own streams must not keep the daemon's event loop alive after it ends.
    child.unref();
    child.stdout.destroy();
    child.stderr.destroy();
    return { pid, cwd: plan.root, plan, dispose };
};

// Every directory in a checkout holding a `.git` entry, root-relative ("" is the root): the root repository's pointer
// and each nested repository's. A fenced sandbox masks them all. Bounded like the mirror walk, and never into a mirror.
export const gitPointersIn = async (worktree: string): Promise<string[]> => {
    const found: string[] = [];
    await walkDirs(worktree, { maxDepth: MAX_LINK_DEPTH + 1 }, async (dir, entries, subdirs) => {
        if (entries.some((entry) => entry.name === ".git")) {
            found.push(dir.rel);
        }
        return subdirs.filter((subdir) => subdir.name !== ".git" && !MIRRORED_DIRS.has(subdir.name));
    });
    return found.toSorted();
};

// Dependency trees, which a folder inside the fence resolves through from above it (the workspace's root
// `node_modules`). Every other mirror is build output, a folder's own work in another form, so it goes in only where the
// fence admits it: a fence on `project/support` keeps the `project` directory on the way down, and `project/dist` is
// built from every sibling the fence leaves out.
const DEPENDENCY_DIRS = new Set(["node_modules", ".venv"]);

// Whether the main checkout's copy of a mirror may stand in a fenced checkout: decided by the fence, and only where the
// checkout itself has the parent, since a mirror is never a reason to conjure a folder the checkout does not carry.
export const mirrorAdmitted = (fence: readonly string[], worktree: string, rel: string): boolean => {
    const parent = dirname(rel) === "." ? "" : dirname(rel);
    const admitted = DEPENDENCY_DIRS.has(basename(rel)) ? parent === "" || fenceReaches(fence, parent) : fenceAllows(fence, rel);
    if (!admitted || parent === "") {
        return admitted;
    }
    try {
        return statSync(join(worktree, parent)).isDirectory();
    } catch {
        return false;
    }
};

/**
 * Every directory in a checkout that the fence neither admits nor leads to, workspace-relative, found by walking down only
 * the paths that lead to the fence's folders (so it costs a readdir per level of the fence, not a walk of the tree). A
 * sparse checkout leaves none where it narrowed cleanly; what this finds is what it left or never could. Files on the way
 * down are not listed: cone mode keeps an ancestor's own files by design (worktree-cone.ts), and a link resolves inside
 * the sandbox, where whatever it names is equally covered.
 */
export const hiddenIn = async (worktree: string, fence: readonly string[]): Promise<string[]> => {
    const hidden: string[] = [];
    const visit = async (rel: string): Promise<void> => {
        const entries = await readdir(join(worktree, rel), { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
            if (fenceAllows(fence, path)) {
                continue;
            }
            if (fenceReaches(fence, path)) {
                await visit(path);
            } else {
                hidden.push(path);
            }
        }
    };
    await visit("");
    return hidden.toSorted();
};

export interface TurnIsolation {
    // The layout mapping, always answered regardless of what this container can enforce; applying it is the caller's
    // choice. Once returned `undefined` instead, collapsing 'no mapping' and 'unenforced' into one silent nothing.
    // `fence` is the folders of the areas the conversation was started with, absent for one started by someone holding
    // none; the sandbox its plan describes is built from it, whatever the checkout was cut to.
    readonly planFor: (worktree: string, fence: Fence) => Promise<IsolationPlan>;
    // Whether the namespace can be built; decides mount points vs symlinks, and which enforcement layer a turn uses.
    readonly available: () => Promise<boolean>;
    // Whether a fenced turn's sandbox can be built (turn-sandbox.ts). Without it a fenced turn is refused.
    readonly sandboxAvailable: () => Promise<boolean>;
}

export const createTurnIsolation = (options: { readonly root: string; readonly historyRoot: string; readonly logger: Logger }): TurnIsolation => {
    const { root, historyRoot, logger } = options;
    // Probed once per daemon life: the answer never changes, and re-probing would spawn a process on every turn.
    let probe: Promise<boolean> | undefined;
    const available = (): Promise<boolean> => {
        probe ??= isolationAvailable(historyRoot).then((ok) => {
            if (!ok) {
                logger.warn(
                    {},
                    "turn isolation unavailable (no CAP_SYS_ADMIN): isolated turns will see the shared /work; recreate the sandbox to enable it",
                );
            }
            return ok;
        });
        return probe;
    };
    let sandboxProbe: Promise<boolean> | undefined;
    const sandboxReady = (): Promise<boolean> => {
        sandboxProbe ??= sandboxAvailable(historyRoot).then((ok) => {
            if (!ok) {
                logger.warn({}, "fenced turns unavailable: bubblewrap could not build a sandbox here, so conversations started by fenced members are refused");
            }
            return ok;
        });
        return sandboxProbe;
    };
    return {
        available,
        sandboxAvailable: sandboxReady,
        // Re-walked per turn, not cached, so a recent install is visible, cheap against a warm dentry cache. Needed
        // even without a namespace; the overlay scratch derives from the worktree's own dir name.
        planFor: async (worktree, fence) => {
            const mirrors = await mirroredDirs(root, worktree, { intoNestedRepos: true });
            const overlays = overlaysDir(historyRoot, basename(worktree));
            if (fence === undefined) {
                return { worktree, root, mirrors, overlays, fence: undefined };
            }
            const folders = fence.map((folder) => foldPath(folder)).filter((folder): folder is string => folder !== undefined);
            return {
                worktree,
                root,
                mirrors: mirrors.filter((rel) => mirrorAdmitted(folders, worktree, rel)),
                overlays,
                fence: {
                    folders,
                    hidden: await hiddenIn(worktree, folders),
                    sessions: sessionsDir(historyRoot, basename(worktree)),
                    gitPointers: await gitPointersIn(worktree),
                },
            };
        },
    };
};

// Subtrees meaning the main checkout on both sides, bound or symlinked over the worktree's own copies; a path into one
// is already correct. `.intentic/config` is not among them: it moves with the root like any tracked file.
// How a workspace path maps into an isolated turn's worktree and back lives beside namespace entry, so a runtime can map
// one without importing this module (workload/worktree-paths.ts); named here too, where its callers look.
export { fromWorktree, inWorktree } from "../../workload/worktree-paths.js";
