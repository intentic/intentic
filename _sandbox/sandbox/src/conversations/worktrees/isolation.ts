import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isMissing } from "@intentic/base/errors";
import { sessionsDir } from "../../sessions/session-store.js";
import { MIRRORED_DIRS } from "@intentic/constants/mirror-roots";
import { type Fence, fenceAllows, fenceReaches, foldPath } from "@intentic/sandbox-contract";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { walkDirs } from "../../workspace/layout/dir-walk.js";
import type { Logger } from "pino";
import { promisify } from "node:util";
import { detachedStamp } from "../../seams/workload-stamp.js";
import { MAIN_MOUNT, PACKAGE_STORE, SHARED_STATE } from "../../workload/worktree-paths.js";
import { type SandboxLayout, sandboxAvailable, startSandboxAnchor } from "./turn-sandbox.js";
import { type NamespaceEntryReference, registerMountEntry } from "../../workload/namespace-entry.js";
import {
    type NamespaceHolder,
    namespaceHolderLifetime,
    namespaceHolderReady,
    type NamespaceSetupError,
    type ReadinessOptions,
    withSetupRetry,
} from "../../workload/namespace-holder.js";
import { opt } from "../../opt.js";
import type { Readable } from "node:stream";
import { signalGroup } from "../../workload/process-group.js";

// An isolated turn's own view of /work: without this, an absolute path (a memory, an AGENTS.md, a message) named the
// shared tree directly, bypassing `land` and losing attribution. A mount namespace makes the worktree BE /work; shared
// state and dependency mirrors are bound back in, everything else is private and dies with the turn.

const execFileAsync = promisify(execFile);

export { MAIN_MOUNT, PACKAGE_STORE } from "../../workload/worktree-paths.js";

// Reference repos cloned only to be read against; workspace content, not repo content, so a worktree needs it mounted
// back in or hits ENOENT. Read-only by contract: a bind ignores `ro`, so the table's `bind,ro` is libmount's bind and then
// its read-only remount (mountTable).
const SHELF = "refs";

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

// One line of the namespace's mount table, as fstab(5) spells it.
export interface MountEntry {
    readonly source: string;
    readonly target: string;
    readonly type: "none" | "overlay";
    readonly options: string;
}

// What the plan alone does not say: whether the main checkout has a reference shelf and a package store to bring back,
// and whether this kernel takes volatile overlays (overlayVolatileAvailable).
export interface MountFacts {
    readonly shelf: boolean;
    readonly store: boolean;
    readonly volatile: boolean;
}

// Where one mirror's overlay layer lives, outside the worktree; the fenced sandbox shares the convention (layerOf).
const layerDirOf = (plan: Pick<IsolationPlan, "overlays">, rel: string): string => join(plan.overlays, encodeURIComponent(rel));

// The namespace's mounts, in the order they are made. Ordering is the whole argument: the root bound aside before the
// worktree shadows it, then shared state, the shelf and the package store from MAIN_MOUNT, then the mirrors over the
// main checkout's copies. Mounted by one `mount -a` (isolationScript); an entry it cannot mount fails the whole setup.
export const mountTable = (plan: IsolationPlan, facts: MountFacts): MountEntry[] => {
    const bind = (source: string, target: string, options = "bind"): MountEntry => ({ source, target, type: "none", options });
    const entries = [bind(plan.root, MAIN_MOUNT), bind(plan.worktree, plan.root)];
    for (const rel of SHARED_STATE) {
        entries.push(bind(join(MAIN_MOUNT, rel), join(plan.root, rel)));
    }
    // Most workspaces have neither; the table carries them only where the main checkout has them (MountFacts).
    if (facts.shelf) {
        // Read-only by contract: libmount makes `bind,ro` the bind and then the read-only remount a bind alone ignores.
        entries.push(bind(join(MAIN_MOUNT, SHELF), join(plan.root, SHELF), "bind,ro"));
    }
    if (facts.store) {
        entries.push(bind(join(MAIN_MOUNT, PACKAGE_STORE), join(plan.root, PACKAGE_STORE)));
    }
    for (const rel of plan.mirrors) {
        const layer = layerDirOf(plan, rel);
        const options = overlayOptions(join(MAIN_MOUNT, rel), join(layer, "upper"), join(layer, "work"));
        entries.push({ source: OVERLAY_FS_NAME, target: join(plan.root, rel), type: "overlay", options: facts.volatile ? `${options},volatile` : options });
    }
    return entries;
};

// fstab(5) separates fields by whitespace and reads octal escapes in each, so a path holding a space, tab, newline or
// backslash is spelled with them.
const fstabField = (value: string): string => value.replace(/[\\ \t\n]/gu, (char) => `\\${char.charCodeAt(0).toString(8).padStart(3, "0")}`);

export const fstabOf = (entries: readonly MountEntry[]): string =>
    `${entries.map((entry) => [fstabField(entry.source), fstabField(entry.target), entry.type, fstabField(entry.options), "0", "0"].join(" ")).join("\n")}\n`;

// The directories every mount in the table needs, named where the daemon sees them, so they exist before the holder
// starts and the holder spends its time mounting rather than spawning a mkdir per mount (the 157 mirrors of 2026-10-13
// were 314 spawns, each a fork and exec on a box already paging). Inside the namespace, `/work/<rel>` is the worktree's
// `<rel>` unless a bind from the main checkout lies over it: there the main checkout's copy is the mount point, and it
// already exists, since the walk found the mirror there.
export const mountPointsOf = (plan: IsolationPlan, facts: Pick<MountFacts, "shelf" | "store">): string[] => {
    const fromMain = [...SHARED_STATE, ...(facts.shelf ? [SHELF] : []), ...(facts.store ? [PACKAGE_STORE] : [])];
    const underMain = (rel: string): boolean => fromMain.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));
    return [
        MAIN_MOUNT,
        ...SHARED_STATE.flatMap((rel) => [join(plan.root, rel), join(plan.worktree, rel)]),
        ...(facts.shelf ? [join(plan.worktree, SHELF)] : []),
        ...(facts.store ? [join(plan.worktree, PACKAGE_STORE)] : []),
        ...plan.mirrors.filter((rel) => !underMain(rel)).map((rel) => join(plan.worktree, rel)),
    ];
};

// One stdout line to signal readiness, then a no-op process to keep the namespace inhabited; `exec`, so the sleep is
// the anchor's own pid.
export const ANCHOR_READY = "isolation-ready";
const ANCHOR_TRAILER = `echo ${ANCHOR_READY}\nexec sleep infinity`;

// The holder's whole script: the namespace made private before anything is mounted (or an isolated turn would rewrite
// the daemon's own /work), then the table, which `-v` reports one line per mount as it goes: the progress its readiness
// reads (namespace-holder.ts). A file, not lines of the script: the script is one argument, which Linux caps at 128 KiB,
// and a mkdir and a mount per mirror had reached 86 KiB.
export const isolationScript = (fstab: string, trailer: string = ANCHOR_TRAILER): string =>
    ["set -e", "mount --make-rprivate /", `mount -a --fstab ${shellQuote(fstab)} -v`, trailer].join("\n");

// The kernel's id for this boot. A layer mounted volatile is trusted again only within the boot that wrote it.
const BOOT_ID = "/proc/sys/kernel/random/boot_id";
// Beside a layer's upper and work: the boot it was last mounted volatile in.
const LAYER_BOOT = "volatile-boot";

const readTrimmed = (path: string): Promise<string | undefined> =>
    readFile(path, "utf8").then(
        (text) => text.trim(),
        // allow(silent-catch): an absent file is the answer here (no boot recorded, or a kernel that names none).
        () => undefined,
    );

// Volatile overlays skip every sync to the upper filesystem, the one on unmount included, which otherwise costs a full
// syncfs of /history per overlay: a turn's 157 of them took 21 s to tear down on a busy disk (2026-10-13, measured),
// against 30 to 50 ms volatile. The price is that writes still in memory when the machine goes down are lost, so the
// kernel leaves a marker in the work dir and refuses the layer until it is cleared. Cleared here within the boot that
// wrote it, which nothing interrupted; a layer last mounted volatile in an earlier boot is thrown away and starts
// empty, since what it holds (installs and build output over the main checkout's) is rebuilt, and half-written it would
// be wrong without saying so.
export const prepareLayer = async (layer: string, boot: string | undefined): Promise<"kept" | "discarded"> => {
    const recorded = await readTrimmed(join(layer, LAYER_BOOT));
    const stale = recorded !== undefined && recorded !== boot;
    if (stale) {
        await rm(join(layer, "upper"), { recursive: true, force: true });
        await rm(join(layer, "work"), { recursive: true, force: true });
        await rm(join(layer, LAYER_BOOT), { force: true });
    } else {
        await rm(join(layer, "work", "work", "incompat"), { recursive: true, force: true });
    }
    await mkdir(join(layer, "upper"), { recursive: true });
    await mkdir(join(layer, "work"), { recursive: true });
    if (boot !== undefined && (stale || recorded !== boot)) {
        await writeFile(join(layer, LAYER_BOOT), `${boot}\n`);
    }
    return stale ? "discarded" : "kept";
};

// Whether this kernel mounts an overlay `volatile` (Linux 5.10+), asked once a daemon life in a throwaway namespace.
let volatileProbe: Promise<boolean> | undefined;
export const overlayVolatileAvailable = (scratchRoot: string): Promise<boolean> => {
    volatileProbe ??= (async () => {
        const dir = join(scratchRoot, ".volatile-probe");
        try {
            await rm(dir, { recursive: true, force: true });
            for (const part of ["lower", "upper", "work", "merged"]) {
                await mkdir(join(dir, part), { recursive: true });
            }
            const options = `${overlayOptions(join(dir, "lower"), join(dir, "upper"), join(dir, "work"))},volatile`;
            await execFileAsync("unshare", ["--mount", "--propagation", "private", "mount", "-t", "overlay", OVERLAY_FS_NAME, "-o", options, join(dir, "merged")], {
                timeout: 5_000,
            });
            return true;
        } catch {
            // allow(silent-catch): a kernel without it mounts the layers as before, synced on unmount.
            return false;
        } finally {
            // allow(silent-catch): the probe's scratch is removed again by the next daemon's first probe.
            await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
    })();
    return volatileProbe;
};

const isDirectory = (path: string): Promise<boolean> =>
    stat(path).then(
        (entry) => entry.isDirectory(),
        // allow(silent-catch): absent is the answer: the main checkout has no shelf or store to bring back.
        () => false,
    );

// What a mount-only holder needs on disk before it starts: every mount point, every layer ready to mount, and the table
// written where the holder reads it. `release` removes the table once the holder has read it, or failed to.
export interface MountView {
    readonly fstab: string;
    readonly mounts: number;
    // Layers thrown away because an earlier boot last mounted them volatile (prepareLayer).
    readonly discarded: number;
    readonly release: () => Promise<void>;
}

export const prepareMountView = async (plan: IsolationPlan, options: { readonly volatile?: boolean } = {}): Promise<MountView> => {
    const [shelf, store, volatile, boot] = await Promise.all([
        isDirectory(join(plan.root, SHELF)),
        isDirectory(join(plan.root, PACKAGE_STORE)),
        options.volatile ?? overlayVolatileAvailable(dirname(plan.overlays)),
        readTrimmed(BOOT_ID),
    ]);
    const facts = { shelf, store, volatile };
    const table = mountTable(plan, facts);
    await Promise.all(mountPointsOf(plan, facts).map((dir) => mkdir(dir, { recursive: true })));
    const layers = await Promise.all(plan.mirrors.map((rel) => prepareLayer(layerDirOf(plan, rel), volatile ? boot : undefined)));
    const dir = join(plan.overlays, ".mounts");
    await mkdir(dir, { recursive: true });
    const fstab = join(dir, `${String(process.pid)}-${randomBytes(4).toString("hex")}.fstab`);
    await writeFile(fstab, fstabOf(table), { mode: 0o600 });
    return {
        fstab,
        mounts: table.length,
        discarded: layers.filter((layer) => layer === "discarded").length,
        // allow(silent-catch): a table left behind is a small file no later holder reads.
        release: () => rm(fstab, { force: true }).catch(() => undefined),
    };
};

// How a process enters an anchor's namespace lives with the rest of process launching, so a runtime can start one
// there without importing this module (workload/namespace-entry.ts); named here too, where its callers look.
export { namespaceTargetOf, nsenterArgv, nsenterPrefix } from "../../workload/namespace-entry.js";

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
    // Every real factory carries the issued generation. Optional only for root-mode legacy descriptors and test seams;
    // this interface is placement plumbing, not authority to admit an unprivileged turn.
    readonly namespace?: NamespaceEntryReference;
    // The workspace root as the namespace sees it; where entrants start.
    readonly cwd: string;
    // What was mounted; every daemon-side reader needs it to translate an agent's paths back.
    readonly plan: IsolationPlan;
    // A fenced turn's sandbox (turn-sandbox.ts): its own temp dir, tmux socket and terminal logs, which the turn's env
    // and the Bash tool's rewrite must point at. Absent for an unfenced turn's plain mount namespace.
    readonly sandbox?: SandboxLayout;
    // An unprivileged agent domain's own directories (domain-anchor.ts). Absent for a root-mode anchor.
    readonly domain?: DomainLayout;
    // Drops the anchor; anything still running inside keeps the namespace alive until it exits.
    readonly dispose: () => void;
}

// What an agent domain adds to its anchor (domain-anchor.ts). `dir` is the conversation's run directory and `tmp` the
// domain's /tmp inside it, both at the same path inside the domain and out; the pane door is the daemon's socket a
// domain's tmux-run asks to open its panes (terminal/pane-door.ts), seen inside at PANE_DOOR_PATH.
export interface DomainLayout {
    readonly dir: string;
    readonly tmp: string;
    readonly door: string;
}

// Whether a placement is a worktree of the conversation's own rather than the main tree. Every turn of a sandbox in
// unprivileged mode has a placement, a main-tree turn's being the workspace itself (domain-anchor.ts), so having one no
// longer says a turn is isolated: what runs only for an isolated turn asks this.
export const ownWorktree = (isolation: TurnPlacement | undefined): isolation is TurnPlacement =>
    isolation !== undefined && isolation.plan.worktree !== isolation.plan.root;

// Where the daemon hands an anchored turn files it must read at the same path (the Bash tool's command files, the MCP
// config, background job dirs): a fenced sandbox's own temp dir, an agent domain's, else the daemon's own.
export const handoffDirOf = (anchor: IsolationAnchor | undefined): string | undefined => anchor?.sandbox?.tmp ?? anchor?.domain?.tmp;

// Resolves only once the mounts are actually up, so no caller can hand work to a half-built namespace. Rejects rather
// than degrading: the capability was already probed, so a failure here is a real fault.
// A fenced plan gets a sandbox instead (turn-sandbox.ts): a mount namespace its own root process could rearrange is no
// fence for a conversation whose person holds only some of the workspace.
export interface AnchorOptions {
    // Told when the first attempt did not answer in time and a second is about to start (withSetupRetry).
    readonly onRetry?: (error: NamespaceSetupError) => void;
    readonly retryDelayMs?: number;
}

export const startAnchor = async (plan: IsolationPlan, options: AnchorOptions = {}): Promise<IsolationAnchor> => {
    const fence = plan.fence;
    return withSetupRetry(() => (fence === undefined ? startMountAnchor(plan) : startSandboxAnchor({ ...plan, fence })), {
        ...opt("onRetry", options.onRetry),
        ...opt("delayMs", options.retryDelayMs),
    });
};

type MountAnchorProcess = NamespaceHolder & {
    readonly stdout: Readable;
    readonly stderr: Readable;
    readonly unref: () => void;
    readonly kill: (signal: NodeJS.Signals) => boolean;
    // Injected with the process so fake PIDs never reach a real signal. Only failed setup uses the whole owned group.
    readonly stopSetup: () => void;
};
const spawnMountAnchor = (_plan: IsolationPlan, view: Pick<MountView, "fstab">): MountAnchorProcess => {
    const child = spawn("unshare", ["--mount", "--propagation", "private", "sh", "-c", isolationScript(view.fstab)], {
        // Stamped, since its own group puts it out of netd's reach when the daemon dies: the next boot ends it
        // (system/boot/generation-sweep.ts), which no turn needs once the daemon that ran it is gone.
        env: { ...process.env, ...detachedStamp("isolation-anchor") },
        stdio: ["ignore", "pipe", "pipe"],
        // Own setup group. Successful disposal kills only the anchor, not independently running panes.
        detached: true,
    });
    return Object.assign(child, { stopSetup: (): void => {
        if (child.pid !== undefined) { signalGroup(child.pid, "SIGKILL"); }
    } });
};

// The seams of the mount-only factory: the holder process, the disk it needs first, its cleanup warnings and its
// readiness clock, each replaced by a fake-data lifecycle test.
export interface MountAnchorSeams {
    readonly start?: (plan: IsolationPlan, view: Pick<MountView, "fstab">) => MountAnchorProcess;
    readonly prepare?: (plan: IsolationPlan) => Promise<Pick<MountView, "fstab" | "release">>;
    readonly warn?: (error: Error) => void;
    readonly readiness?: ReadinessOptions;
}

// The real mount-only factory. A fenced plan cannot take this door.
export const startMountAnchor = async (plan: IsolationPlan, seams: MountAnchorSeams = {}): Promise<IsolationAnchor> => {
    if (plan.fence !== undefined) { throw new Error("a fenced turn requires its sandbox, not a mount-only anchor"); }
    const warn = seams.warn ?? ((error: Error) => { process.emitWarning(`turn isolation cleanup failed: ${error.message}`); });
    const view = await (seams.prepare ?? prepareMountView)(plan);
    try {
        return await holdMountAnchor(plan, (seams.start ?? spawnMountAnchor)(plan, view), warn, seams.readiness);
    } finally {
        // Read by `mount -a` before the holder said anything; the namespace never reads it again.
        await view.release();
    }
};

const holdMountAnchor = async (
    plan: IsolationPlan,
    child: MountAnchorProcess,
    warn: (error: Error) => void,
    readiness: ReadinessOptions | undefined,
): Promise<IsolationAnchor> => {
    let admitted = false;
    const lifetime = namespaceHolderLifetime(child, () => {
        try {
            if (admitted) { child.kill("SIGKILL"); } else { child.stopSetup(); }
        } catch (error) {
            // An owned-group signal refusal is reported, not thrown out of an exit/error EventEmitter listener.
            // The independent readiness listener must still settle the setup refusal.
            warn(error instanceof Error ? error : new Error(String(error)));
        } finally {
            if (!admitted) { child.stdout.destroy(); child.stderr.destroy(); }
        }
    });
    try {
        if (child.pid === undefined) { throw new Error("turn isolation: could not spawn the namespace anchor"); }
        const pid = await namespaceHolderReady(child, ANCHOR_READY, undefined, readiness);
        const namespace = lifetime.register(() => registerMountEntry(pid));
        // The turn's own streams must not keep the daemon's event loop alive after it ends.
        child.unref();
        child.stdout.destroy();
        child.stderr.destroy();
        admitted = true;
        return { pid, namespace, cwd: plan.root, plan, dispose: lifetime.end };
    } catch (error) {
        lifetime.end();
        throw error;
    }
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
    } catch (error) {
        // Absent from the checkout is the answer; a parent it cannot read is not one.
        if (isMissing(error)) {
            return false;
        }
        throw error;
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
        // A folder gone since the walk began holds nothing to cover; one that cannot be read might, so the plan fails
        // and the turn is refused rather than run with part of the checkout left uncovered.
        const entries = await readdir(join(worktree, rel), { withFileTypes: true }).catch((error: unknown) => {
            if (isMissing(error)) {
                return [];
            }
            throw error;
        });
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
