import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { MIRRORED_DIRS } from "@intentic/constants/mirror-roots";
import { SHARED_STATE_PATHS } from "@intentic/sandbox-contract";
import { IGNORED_DIRS } from "@intentic/workspace-ignore";
import { shellQuote } from "@intentic/sandbox-run/quote";
import type { Logger } from "pino";
import { promisify } from "node:util";

// An isolated turn's own view of /work: without this, an absolute path (a memory, CLAUDE.md, a message) named the
// shared tree directly, bypassing `land` and losing attribution. A mount namespace makes the worktree BE /work; shared
// state and dependency mirrors are bound back in, everything else is private and dies with the turn.

const execFileAsync = promisify(execFile);

// Stable path to the real workspace root inside the namespace, for a turn that genuinely needs the shared tree.
export const MAIN_MOUNT = "/mnt/intentic-main";

// State subtrees kept shared, not per-worktree; root-relative, no trailing slash. Sorted shallowest-first so a parent
// mounted after a child could never shadow it.
const SHARED_STATE = SHARED_STATE_PATHS.map((path) => path.replace(/\/$/, "")).toSorted(
    (a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1),
);

// Reference repos cloned only to be read against; workspace content, not repo content, so a worktree needs it mounted
// back in or hits ENOENT. Read-only by contract: a bind ignores `ro`, so the remount is a second step.
const SHELF = "refs";

// Deps and build output a checkout can't carry (MIRRORED_DIRS); caches excluded, a stale tsbuildinfo would falsely
// agree with the mirror. Each name is a live overlay's lowerdir: empty it, never replace it.

// Same depth bound as the symlink mirroring this replaces.
const MAX_LINK_DEPTH = 3;

export interface IsolationPlan {
    // The conversation's root-repo worktree; what /work becomes.
    readonly worktree: string;
    // The real workspace root, bound aside at MAIN_MOUNT.
    readonly root: string;
    // Root-relative dirs mirrored from the main checkout; shallowest-first so a parent can't shadow a child.
    readonly mirrors: readonly string[];
    // Where this conversation's overlay layers live, outside the worktree so installs don't show in `git status`.
    readonly overlays: string;
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

// `--wd` resolves before setns, landing on the daemon's unreachable /work (this crashed the Codex app-server at
// startup). `--wdns` resolves after setns, the only reading of /work that means the worktree.
// `--wdns` moves the kernel's cwd, but the entrant inherits the daemon's own stale `$PWD`, and bash's check passes
// since both names are one inode. Unset, not reassigned, so every shell falls back to the correct getcwd().
const NO_INHERITED_CWD = ["env", "-u", "PWD", "-u", "OLDPWD"] as const;

export const nsenterArgv = (anchorPid: number, cwd: string, command: string, args: readonly string[]): { command: string; args: string[] } => ({
    command: "nsenter",
    args: [`--mount=/proc/${anchorPid}/ns/mnt`, `--wdns=${cwd}`, "--", ...NO_INHERITED_CWD, command, ...args],
});

// The same flags as one shell word, for callers that compose a command string rather than an argv (the tmux rewrite, a
// rule's command), where an inherited PWD would decide a relative path's meaning. Quoted against a space splitting it.
export const nsenterPrefix = (anchorPid: number, cwd: string): string =>
    `nsenter --mount=/proc/${anchorPid}/ns/mnt --wdns=${shellQuote(cwd)} -- ${NO_INHERITED_CWD.join(" ")} `;

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
    const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        if (!intoNestedRepos && rel !== "" && entries.some((entry) => entry.name === ".git")) {
            return;
        }
        await Promise.all(
            entries
                .filter((entry) => entry.isDirectory() && MIRRORED_DIRS.has(entry.name))
                .map(async (entry) => {
                    const mirror = rel === "" ? entry.name : `${rel}/${entry.name}`;
                    if (await mirrorable(join(worktree, mirror))) {
                        found.push(mirror);
                    }
                }),
        );
        if (depth >= MAX_LINK_DEPTH) {
            return;
        }
        // A mirror's own contents are never mirror points; walking an installed tree would cost thousands of readdirs.
        await Promise.all(
            entries
                .filter(
                    (entry) => entry.isDirectory() && !entry.name.startsWith(".") && !MIRRORED_DIRS.has(entry.name) && !IGNORED_DIRS.has(entry.name),
                )
                .map((entry) => walk(join(dir, entry.name), rel === "" ? entry.name : `${rel}/${entry.name}`, depth + 1)),
        );
    };
    await walk(main, "", 0);
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
    // Drops the anchor; anything still running inside keeps the namespace alive until it exits.
    readonly dispose: () => void;
}

// Resolves only once the mounts are actually up, so no caller can hand work to a half-built namespace. Rejects rather
// than degrading: the capability was already probed, so a failure here is a real fault.
export const startAnchor = async (plan: IsolationPlan): Promise<IsolationAnchor> => {
    const child = spawn("unshare", ["--mount", "--propagation", "private", "sh", "-c", isolationScript(plan)], {
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

export interface TurnIsolation {
    // The layout mapping, always answered regardless of what this container can enforce; applying it is the caller's
    // choice. Once returned `undefined` instead, collapsing 'no mapping' and 'unenforced' into one silent nothing.
    readonly planFor: (worktree: string) => Promise<IsolationPlan>;
    // Whether the namespace can be built; decides mount points vs symlinks, and which enforcement layer a turn uses.
    readonly available: () => Promise<boolean>;
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
    return {
        available,
        // Re-walked per turn, not cached, so a recent install is visible, cheap against a warm dentry cache. Needed
        // even without a namespace; the overlay scratch derives from the worktree's own dir name.
        planFor: async (worktree) => ({
            worktree,
            root,
            mirrors: await mirroredDirs(root, worktree, { intoNestedRepos: true }),
            overlays: overlaysDir(historyRoot, basename(worktree)),
        }),
    };
};

// Subtrees meaning the main checkout on both sides, bound or symlinked over the worktree's own copies; a path into one
// is already correct. `.intentic/config` is not among them: it moves with the root like any tracked file.
const sharedPrefixes = (plan: IsolationPlan): string[] => [...SHARED_STATE, ...plan.mirrors];

// Which file a workspace path names for an isolated turn: the daemon uses it for a reported path, worktree-redirect.ts
// when there's no namespace. Only the root prefix moves; the rest is already correct.
export const inWorktree = (path: string, plan: IsolationPlan | undefined): string => {
    if (plan === undefined || (path !== plan.root && !path.startsWith(`${plan.root}/`))) {
        return path;
    }
    const rel = path === plan.root ? "" : path.slice(plan.root.length + 1);
    if (sharedPrefixes(plan).some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) {
        return path;
    }
    // The root itself maps to the worktree root: `ls /work` must list the agent's own tree.
    return rel === "" ? plan.worktree : join(plan.worktree, rel);
};

// The same mapping backwards: what the agent calls a file the daemon named, so a daemon-side answer quoted back never
// hands over the real worktree path, which reads as an instruction to leave the namespace.
export const fromWorktree = (path: string, plan: IsolationPlan | undefined): string => {
    if (plan === undefined || (path !== plan.worktree && !path.startsWith(`${plan.worktree}/`))) {
        return path;
    }
    return path === plan.worktree ? plan.root : join(plan.root, path.slice(plan.worktree.length + 1));
};
