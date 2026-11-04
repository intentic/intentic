import { execFile, spawn } from "node:child_process";
import { lstatSync, readlinkSync } from "node:fs";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { STATE_DIR } from "@intentic/constants";
import { MIRRORED_DIRS } from "@intentic/constants/mirror-roots";
import { ROOM_SOCKET } from "@intentic/constants/memory-room";
import { AGENT_TOKEN_PATH } from "../../auth/tokens/agent-token.js";
import { hostsDir } from "../../capabilities/ssh-hosts.js";
import { enginesRoot } from "../../engines/engine-store.js";
import { gpuStateFile } from "../../hosts/gpu/gpu-state.js";
import { detachedStamp } from "../../seams/workload-stamp.js";
import { SESSION_STATE } from "../../sessions/session-store.js";
import { stateRelPath } from "../../state-paths.js";
import { queueRoot } from "../../system/resources/queue-slots.js";
import { PROMPT_SIGNAL_DIR } from "../../terminal/prompt-signal.js";
import { registerSandboxEntry } from "../../workload/namespace-entry.js";
import { namespaceHolderLifetime, namespaceHolderReady } from "../../workload/namespace-holder.js";
import { SHARED_STATE } from "../../workload/worktree-paths.js";
import { walkDirs } from "../../workspace/layout/dir-walk.js";
import type { FencedPlacement, IsolationAnchor, IsolationPlan } from "./isolation.js";

// Fence turns with unprivileged bubblewrap (no capabilities/user namespaces), private PID/proc and an allowlisted filesystem.
// System paths are read-only with sensitive files masked; /work is writable but .git and excluded areas are hidden.
// Admit only fenced dependency/build mirrors and refs; isolate home/config and pnpm hard links while sharing heavy-command locks.
// Keep TMPDIR, tmux and logs at identical paths inside/outside for daemon command files. The container's network, including loopback, is shared.

// The user every fenced turn runs as inside its sandbox. One fixed id rather than one per turn: two sandboxes never
// share a pid or mount namespace, so the id separates nothing between them, and a fixed one keeps file ownership in the
// checkout stable across turns.
export const SANDBOX_UID = 1000;
export const SANDBOX_GID = 1000;

// The descriptor bwrap reports the sandbox's own pid on (`--info-fd`): the pid every entrant joins by.
const INFO_FD = 3;

const READY = "sandbox-ready";

// Top-level system paths that are either directories (bound read-only) or, on a merged-/usr system, links into /usr
// (recreated as the same links).
const SYSTEM_PATHS = ["/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"] as const;

// What /etc holds that no turn needs and a person's area must not reach.
const ETC_FILES_MASKED = ["/etc/shadow", "/etc/shadow-", "/etc/gshadow", "/etc/gshadow-"] as const;
const ETC_DIRS_MASKED = ["/etc/ssh"] as const;

// The home a fenced turn gets: these, read-only, from the daemon's own home. Credentials kept there (ssh keys, git
// and runtime logins, the daemon's own state) are not among them.
const HOME_READ_ONLY = [".bashrc", ".profile", ".zshrc", ".tmux.conf", ".gitconfig", ".oh-my-zsh", ".bun", ".local"] as const;
// The Claude CLI's own config dir: read as the daemon left it, written to a throwaway layer, since the CLI writes
// small state files there on every start and must not change the sandbox-wide copy.
const HOME_OVERLAID = [".claude"] as const;

// The fixed name of the session store inside the checkout (`~/.claude/<name>` links point under it).
const SESSION_STORE = stateRelPath(".intentic/records/sessions/claude/");
const SHELF = "refs";
const PACKAGE_STORE = ".pnpm-store";

/* THE WHOLE-WORKSPACE JAIL (2026-11-04). While conversations can be private (conversations/seal/seal-jail.ts), every turn
   runs in this sandbox, not only a fenced one: as root over the shared tree a turn reads the history volume whole (every
   transcript, the roster, the session secret) and every conversation's runtime session files. Its fence is the whole
   workspace: every folder visible and writable as before, git whole, nothing narrowed, covered or masked. Over the
   fenced sandbox it keeps what an unfenced turn needs and reaches nothing of another conversation: the repositories' git
   directories, the agent token and memory room its CLIs and heavy commands ask, its own ssh agent and the machines' public
   halves, the GPU and KVM devices, and the caches its installs and browsers read. The workspace's secrets and identity
   files (PRIVATE_STATE), every other runtime's store under HOME, docker and netd stay out. */
export interface WholeJail {
    // The repositories' real git directories (workspace/layout/git-dir-owners.ts gitsRoot), bound whole and writable:
    // what every checkout's `.git` pointer leads into, so status, log, commit and branches work as they do unjailed.
    readonly gits: string;
    // The conversation's own ssh agent socket (agent/run/harness/turn-env.ts), bound at its path when it has one.
    readonly sshSocket?: string;
}

/** The whole-workspace jail over a turn's ordinary plan: nothing narrowed, covered or masked, its own session store. */
export const jailPlanOf = (base: IsolationPlan, sessions: string, jail: WholeJail): FencedPlan => ({
    ...base,
    fence: { folders: [""], hidden: [], sessions, gitPointers: [], whole: jail },
});

// The workspace's state the jail never shows, workspace-relative: the secrets and the identity files (the roster, the
// control tokens, the passkeys), as the agent domain masks them (workload/domain/agent-domain-view.ts PRIVATE_STATE).
const PRIVATE_STATE = [join(STATE_DIR, "secrets"), join(STATE_DIR, "identity")];
// What of /run/intentic a jailed turn reaches: the token its CLIs present (bin/agents), the memory room its heavy
// commands ask (workload/room-socket.ts), the GPU state gpu-run reads, and the prompt signal a shell touches. Never
// netd's control socket, the daemon's own, or another conversation's ssh agent.
const runEndpoints = (): string[] => [AGENT_TOKEN_PATH, ROOM_SOCKET, gpuStateFile(), PROMPT_SIGNAL_DIR];
// Devices an unfenced turn's builds and emulators use, passed through where the container has them.
const JAIL_DEVICES = ["/dev/dri", "/dev/dxg", "/dev/kvm", "/dev/nvidiactl", "/dev/nvidia-modeset", "/dev/nvidia-uvm", "/dev/nvidia-uvm-tools", "/dev/nvidia0", "/dev/nvidia1"];
// The caches an unfenced turn's installs and browsers read (Playwright's browsers, pnpm's and npm's downloads), behind a
// throwaway layer each like the Claude config. Tool configs and credential files stay out, as they do for a fenced turn.
const JAIL_HOME_OVERLAID = [".cache", ".npm"] as const;
// Other runtimes' stores and logs inside what the home shows, each holding the words of every conversation that runtime
// served, and the daemon's own local certificate authority: covered by an empty layer.
const JAIL_HOME_MASKED = [".cache/claude-cli-nodejs", ".cache/opencode", ".cache/devin", ".local/share/opencode", ".local/state/opencode", ".local/share/devin", ".local/share/intentic"] as const;

// Paths inside the sandbox's own dir.
export interface SandboxLayout {
    readonly dir: string;
    readonly tmp: string;
    readonly tmuxSocket: string;
    readonly terminalLogs: string;
    readonly held: string;
    // An empty regular file, bound over whatever the sandbox masks. Not /dev/null: a device node cannot be opened from a
    // mount inside a user namespace, so masked paths would read as "permission denied" rather than as empty.
    readonly empty: string;
}

export const sandboxLayout = (dir: string): SandboxLayout => ({
    dir,
    tmp: join(dir, "tmp"),
    tmuxSocket: join(dir, "tmux", "default"),
    terminalLogs: join(dir, "logs", "terminals"),
    held: join(dir, "held"),
    empty: join(dir, "empty"),
});

// What a fenced turn's processes need told about their sandbox, since an entrant inherits the env its spawner hands it
// rather than the anchor's: where its temp files go, which tmux server is its own, where its terminal logs are kept and
// which queue its heavy commands wait in.
export const sandboxEnv = (layout: Pick<SandboxLayout, "tmp" | "tmuxSocket" | "terminalLogs">, queue: string = queueRoot()) => ({
    TMPDIR: layout.tmp,
    INTENTIC_TMUX_SOCKET: layout.tmuxSocket,
    INTENTIC_TERMINAL_LOGS_DIR: layout.terminalLogs,
    INTENTIC_QUEUE_DIR: queue,
});

// What of the host the argv depends on, read once before it is built, so building it is a pure function a test can
// pin without a filesystem.
export interface HostView {
    // Absolute path -> link target, for the system paths that are symlinks.
    readonly links: ReadonlyMap<string, string>;
    // Absolute paths that exist.
    readonly present: ReadonlySet<string>;
}

export interface SandboxSources {
    readonly home: string;
    readonly engines: string;
    readonly queue: string;
}

export const defaultSources = (): SandboxSources => ({
    home: homedir(),
    engines: enginesRoot(),
    queue: queueRoot(),
});

// The fence's own folders on the shelf, shallowest first and none inside another: all of it for a fence holding the
// shelf whole, nothing for one naming nothing there.
export const shelfFolders = (folders: readonly string[]): string[] => {
    const onShelf = folders.filter((folder) => folder === SHELF || folder.startsWith(`${SHELF}/`)).toSorted();
    return onShelf.filter((folder) => !onShelf.some((other) => other !== folder && folder.startsWith(`${other}/`)));
};

export const hostPathsFor = (plan: IsolationPlan, sources: SandboxSources): string[] => [
    ...SYSTEM_PATHS,
    "/opt",
    sources.engines,
    ...ETC_FILES_MASKED,
    ...ETC_DIRS_MASKED,
    ...HOME_READ_ONLY.map((name) => join(sources.home, name)),
    ...HOME_OVERLAID.map((name) => join(sources.home, name)),
    ...shelfFolders(plan.fence?.folders ?? []).map((folder) => join(plan.root, folder)),
    join(plan.root, PACKAGE_STORE),
    ...(plan.fence?.whole === undefined ? [] : jailHostPaths(plan, plan.fence.whole, sources)),
];

// What else of the host a whole-workspace jail's argv depends on: each read in the daemon's view, where a path under the
// workspace root names the main checkout's copy.
const jailHostPaths = (plan: IsolationPlan, jail: WholeJail, sources: SandboxSources): string[] => [
    ...JAIL_DEVICES,
    ...runEndpoints(),
    ...(jail.sshSocket === undefined ? [] : [jail.sshSocket]),
    jail.gits,
    hostsDir(),
    join(sources.home, ".ssh", "config"),
    ...[...JAIL_HOME_OVERLAID, ...JAIL_HOME_MASKED].map((name) => join(sources.home, name)),
    ...[...SHARED_STATE, ...PRIVATE_STATE, SHELF].flatMap((rel) => [join(plan.root, rel), join(plan.worktree, rel)]),
];

// Every directory in a checkout holding a `.git` entry, root-relative ("" is the root): the root repository's pointer
// and each nested repository's. A fenced sandbox masks them all. Bounded like the mirror walk (isolation.ts), and never
// into a mirror.
export const gitPointersIn = async (worktree: string): Promise<string[]> => {
    const found: string[] = [];
    await walkDirs(worktree, { maxDepth: 4 }, async (dir, entries, subdirs) => {
        if (entries.some((entry) => entry.name === ".git")) {
            found.push(dir.rel);
        }
        return subdirs.filter((subdir) => subdir.name !== ".git" && !MIRRORED_DIRS.has(subdir.name));
    });
    return found.toSorted();
};

// Where a layer over a main-checkout directory keeps this conversation's writes; the mirrors' convention, shared.
export const layerOf = (plan: Pick<IsolationPlan, "overlays">, rel: string): string => join(plan.overlays, encodeURIComponent(rel));

export const readHostView = (paths: readonly string[]): HostView => {
    const links = new Map<string, string>();
    const present = new Set<string>();
    for (const path of paths) {
        try {
            const entry = lstatSync(path);
            present.add(path);
            if (entry.isSymbolicLink()) {
                links.set(path, readlinkSync(path));
            }
        } catch {
            // allow(silent-catch): a host path that cannot be read is left out of the sandbox, the fence's safe side.
        }
    }
    return { links, present };
};

export type FencedPlan = IsolationPlan & { readonly fence: FencedPlacement };

// The args for each path the host has, and nothing for one it lacks: an absent path is left out, never stood in for.
const present = (host: HostView, paths: readonly string[], toArgs: (path: string) => string[]): string[] =>
    paths.flatMap((path) => (host.present.has(path) ? toArgs(path) : []));

// The system, read-only: /usr, the top-level paths that are links into it or directories of their own, /etc with what
// no turn needs masked, /opt and the runtime engines.
const systemArgs = (empty: string, host: HostView, sources: SandboxSources): string[] => {
    const args = ["--ro-bind", "/usr", "/usr"];
    for (const path of SYSTEM_PATHS) {
        const link = host.links.get(path);
        if (link !== undefined) {
            args.push("--symlink", link, path);
        } else if (host.present.has(path)) {
            args.push("--ro-bind", path, path);
        }
    }
    args.push("--ro-bind", "/etc", "/etc");
    args.push(...present(host, ETC_FILES_MASKED, (path) => ["--ro-bind", empty, path]));
    args.push(...present(host, ETC_DIRS_MASKED, (path) => ["--tmpfs", path]));
    args.push(...present(host, ["/opt", sources.engines], (path) => ["--ro-bind", path, path]));
    return args;
};

// A home of its own: empty, with the listed dotfiles read-only and the Claude config behind a throwaway layer.
const homeArgs = (host: HostView, sources: SandboxSources): string[] => [
    "--tmpfs",
    sources.home,
    ...present(
        host,
        HOME_READ_ONLY.map((name) => join(sources.home, name)),
        (path) => ["--ro-bind", path, path],
    ),
    ...present(
        host,
        HOME_OVERLAID.map((name) => join(sources.home, name)),
        (path) => ["--overlay-src", path, "--tmp-overlay", path],
    ),
];

// A main-checkout directory read through a layer of the conversation's own, which takes every write.
const overlayArgs = (plan: FencedPlan, rel: string): string[] => {
    const layer = layerOf(plan, rel);
    return ["--overlay-src", join(plan.root, rel), "--overlay", join(layer, "upper"), join(layer, "work"), join(plan.root, rel)];
};

// A whole-workspace jail's own devices, /run endpoints and HOME, each only where the host has it. The ssh client reads
// the machines' configs and public halves (capabilities/ssh-hosts.ts), never a private key: the agent socket signs.
const jailDeviceArgs = (host: HostView): string[] => present(host, JAIL_DEVICES, (path) => ["--dev-bind", path, path]);

const jailRunArgs = (jail: WholeJail, host: HostView): string[] => [
    ...present(host, [AGENT_TOKEN_PATH, gpuStateFile()], (path) => ["--ro-bind", path, path]),
    ...present(host, [ROOM_SOCKET, PROMPT_SIGNAL_DIR, ...(jail.sshSocket === undefined ? [] : [jail.sshSocket])], (path) => ["--bind", path, path]),
];

const jailHomeArgs = (host: HostView, sources: SandboxSources): string[] => [
    ...present(host, [join(sources.home, ".ssh", "config"), hostsDir()], (path) => ["--ro-bind", path, path]),
    ...present(
        host,
        JAIL_HOME_OVERLAID.map((name) => join(sources.home, name)),
        (path) => ["--overlay-src", path, "--tmp-overlay", path],
    ),
    ...present(
        host,
        JAIL_HOME_MASKED.map((name) => join(sources.home, name)),
        (path) => ["--tmpfs", path],
    ),
];

// The whole workspace at its root, read-write, with nothing covered and no pointer masked. An isolated turn's checkout
// gets the shared state back from the main checkout as its mount namespace would (isolation.ts mountTable), the shelf
// read-only and the package store and the mirrors behind its own layers, as a fenced turn's; a main-tree turn's checkout
// is the main checkout, which holds all of them already. Then the workspace's secrets and identity files are covered,
// the conversation's own session store stands over the shared one, and the git directories every pointer leads into.
// `store` is how the session store is laid over the shared one: the conversation's own bound there, or an empty layer.
const jailCheckoutArgs = (plan: FencedPlan, jail: WholeJail, host: HostView, store: readonly string[]): string[] => {
    const isolated = plan.worktree !== plan.root;
    const fromMain = (rel: string, flag: string): string[] => {
        const path = join(plan.root, rel);
        return isolated && host.present.has(path) ? [flag, path, path] : [];
    };
    const covered = PRIVATE_STATE.filter((rel) => host.present.has(join(plan.root, rel)) || host.present.has(join(plan.worktree, rel)));
    return [
        "--bind",
        plan.worktree,
        plan.root,
        ...SHARED_STATE.filter((rel) => !PRIVATE_STATE.includes(rel)).flatMap((rel) => fromMain(rel, "--bind")),
        ...covered.flatMap((rel) => ["--tmpfs", join(plan.root, rel)]),
        ...store,
        join(plan.root, SESSION_STORE),
        ...fromMain(SHELF, "--ro-bind"),
        ...(isolated && host.present.has(join(plan.root, PACKAGE_STORE)) ? overlayArgs(plan, PACKAGE_STORE) : []),
        ...plan.mirrors.flatMap((rel) => overlayArgs(plan, rel)),
        ...present(host, [jail.gits], (path) => ["--bind", path, path]),
    ];
};

// The conversation's checkout at the workspace root, what the fence does not reach in it covered, its repository
// pointers masked, its own session store, and what it shares with the main checkout: the fence's part of the shelf
// read-only, and the package store and the mirrors behind layers of its own. The covers come right after the checkout,
// so whatever is placed inside one later (a session store under `.intentic`, the store at the root) still shows.
const checkoutArgs = (plan: FencedPlan, layout: SandboxLayout, host: HostView): string[] => {
    const store = join(plan.root, PACKAGE_STORE);
    return [
        "--bind",
        plan.worktree,
        plan.root,
        ...plan.fence.hidden.flatMap((rel) => ["--tmpfs", join(plan.root, rel)]),
        ...plan.fence.gitPointers.flatMap((rel) => ["--ro-bind", layout.empty, join(plan.root, rel, ".git")]),
        "--bind",
        plan.fence.sessions,
        join(plan.root, SESSION_STORE),
        ...shelfFolders(plan.fence.folders).flatMap((folder) => {
            const shelf = join(plan.root, folder);
            return host.present.has(shelf) ? ["--ro-bind", shelf, shelf] : [];
        }),
        ...(host.present.has(store) ? overlayArgs(plan, PACKAGE_STORE) : []),
        ...plan.mirrors.flatMap((rel) => overlayArgs(plan, rel)),
    ];
};

// The namespaces, the system, /proc, /dev, the temp dirs and HOME: every sandbox's, a person's shell's included. A
// whole-workspace jail keeps the container's hostname, as the turn had it unjailed; a fenced one is named for what it is.
const viewArgs = (plan: FencedPlan, empty: string, host: HostView, sources: SandboxSources): string[] => {
    const jail = plan.fence.whole;
    return [
        "--unshare-user",
        "--uid",
        String(SANDBOX_UID),
        "--gid",
        String(SANDBOX_GID),
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-cgroup-try",
        "--disable-userns",
        "--cap-drop",
        "ALL",
        ...(jail === undefined ? ["--hostname", "fenced"] : []),
        ...systemArgs(empty, host, sources),
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        ...(jail === undefined ? [] : jailDeviceArgs(host)),
        "--tmpfs",
        "/tmp",
        "--tmpfs",
        "/run",
        "--tmpfs",
        "/var",
        ...(jail === undefined ? [] : jailRunArgs(jail, host)),
        ...homeArgs(host, sources),
        ...(jail === undefined ? [] : jailHomeArgs(host, sources)),
    ];
};

// The whole bwrap command line for one fenced or jailed turn, up to and excluding the command it runs. bwrap applies
// mounts in order, so a parent always comes before what is laid over it. Sources are read in the daemon's own view,
// before any of these binds, which is why a path under the workspace root names the main checkout's copy.
export const sandboxArgs = (plan: FencedPlan, layout: SandboxLayout, host: HostView, sources: SandboxSources): string[] => {
    const jail = plan.fence.whole;
    return [
        ...viewArgs(plan, layout.empty, host, sources),
        "--bind",
        layout.dir,
        layout.dir,
        "--bind",
        sources.queue,
        sources.queue,
        ...(jail === undefined ? checkoutArgs(plan, layout, host) : jailCheckoutArgs(plan, jail, host, ["--bind", plan.fence.sessions])),
        "--chdir",
        plan.root,
        "--setenv",
        "HOME",
        sources.home,
        ...Object.entries(sandboxEnv(layout, sources.queue)).flatMap(([name, value]) => ["--setenv", name, value]),
        "--info-fd",
        String(INFO_FD),
    ];
};

// A PERSON'S SHELL IN THE JAIL (terminal/shell-jail.ts): the main checkout as a main-tree turn's jail shows it, with no
// anchor to hold, since each shell is a sandbox of its own that tmux starts in its pane and ends with it. Its session
// store is an empty layer, so a `claude` a person runs by hand reads no conversation's sessions and keeps none past the
// shell; its temp dir is its own /tmp. Everything but the directory it opens in, which the pane names as it starts.
export const shellJailArgs = (plan: FencedPlan & { readonly fence: { readonly whole: WholeJail } }, empty: string, host: HostView, sources: SandboxSources): string[] => [
    ...viewArgs(plan, empty, host, sources),
    "--bind",
    sources.queue,
    sources.queue,
    ...jailCheckoutArgs(plan, plan.fence.whole, host, ["--tmpfs"]),
    "--setenv",
    "HOME",
    sources.home,
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "INTENTIC_QUEUE_DIR",
    sources.queue,
    // The server these name is outside the shell's sandbox; a tmux run inside would take itself for a nested client.
    "--unsetenv",
    "TMUX",
    "--unsetenv",
    "TMUX_PANE",
];

/** A person's shell's jail over the workspace at `root`, read from the host as it stands now. */
export const peopleShellArgs = (root: string, jail: WholeJail, empty: string, sources: SandboxSources = defaultSources()): string[] => {
    // No session store and no layers of its own: the shell's store is an empty layer, and the main checkout has no mirrors.
    const plan = { worktree: root, root, mirrors: [], overlays: root, fence: { folders: [""], hidden: [], sessions: root, gitPointers: [], whole: jail } };
    return shellJailArgs(plan, empty, readHostView(hostPathsFor(plan, sources)), sources);
};

// The process that holds the sandbox open. bwrap's own init ends the namespace, and everything still in it, the moment
// this exits, so it stays while the turn holds it (`held` exists) and, once released, while anything the turn left
// running is still running: a dev server the person kept outlives the turn, as it does in an unfenced one. A tmux
// server counts as left running only while one of its panes is alive.
// Arguments: the held marker, then the tmux socket.
export const ANCHOR_SCRIPT = [
    `held="$1"; sock="$2"`,
    `trap 'exit 0' TERM INT`,
    `echo ${READY}`,
    `while :; do`,
    `  sleep 3`,
    `  [ -e "$held" ] && continue`,
    `  if [ -S "$sock" ]; then`,
    `    tmux -S "$sock" list-panes -a -F '#{pane_dead} #{window_id}' 2>/dev/null | awk '$1==1{print $2}' | while read -r w; do tmux -S "$sock" kill-window -t "$w" 2>/dev/null; done`,
    `    tmux -S "$sock" list-panes -a -F '#{pane_dead}' 2>/dev/null | grep -qx 0 || tmux -S "$sock" kill-server 2>/dev/null`,
    `  fi`,
    `  set -- /proc/[0-9]*`,
    // bwrap's init (pid 1) and this shell: anything beyond those is the turn's.
    `  [ "$#" -le 2 ] && exit 0`,
    `done`,
].join("\n");

// allow(process-tiers): only the availability probe below, a `bwrap … true` bounded by its own 10 s timeout.
const execFileAsync = promisify(execFile);

// Whether this container can build a fenced turn's sandbox at all: bubblewrap with user and pid namespaces, and overlays
// inside one. Without it a fenced turn is refused rather than run with a fence it lacks.
export const sandboxAvailable = async (scratch: string): Promise<boolean> => {
    const dir = join(scratch, ".sandbox-probe");
    try {
        await rm(dir, { recursive: true, force: true });
        for (const part of ["lower", "upper", "work"]) {
            await mkdir(join(dir, part), { recursive: true });
        }
        await execFileAsync(
            "bwrap",
            [
                "--unshare-user",
                "--uid",
                String(SANDBOX_UID),
                "--unshare-pid",
                "--disable-userns",
                "--cap-drop",
                "ALL",
                "--ro-bind",
                "/",
                "/",
                "--tmpfs",
                "/tmp",
                "--overlay-src",
                join(dir, "lower"),
                "--overlay",
                join(dir, "upper"),
                join(dir, "work"),
                "/tmp/merged",
                "--",
                "true",
            ],
            { timeout: 10_000 },
        );
        return true;
    } catch {
        // allow(silent-catch): any failure means this container cannot build the fence, and a fenced turn is refused.
        return false;
    } finally {
        // allow(silent-catch): the probe's scratch dir is removed again by the next probe's first step.
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
};

// Starts a fenced turn's sandbox and answers once it is up. Rejects on any failure with the sandbox torn down: a
// fenced turn never runs in half of one.
export const startSandboxAnchor = async (plan: FencedPlan, sources: SandboxSources = defaultSources()): Promise<IsolationAnchor> => {
    const layout = sandboxLayout(join(plan.overlays, `sandbox-${randomBytes(4).toString("hex")}`));
    let teardownTask: Promise<void> | undefined;
    const teardown = (): Promise<void> => {
        // allow(silent-catch): best effort, after a start that already failed; what stays behind is disk under the overlays.
        teardownTask ??= rm(layout.dir, { recursive: true, force: true }).catch(() => undefined);
        return teardownTask;
    };
    await mkdir(layout.tmp, { recursive: true, mode: 0o700 });
    await mkdir(join(layout.tmuxSocket, ".."), { recursive: true, mode: 0o700 });
    await mkdir(layout.terminalLogs, { recursive: true, mode: 0o700 });
    await mkdir(sources.queue, { recursive: true });
    // The store's own directories, not just its root: `~/.claude/<name>` links point at each by name.
    for (const name of SESSION_STATE) {
        await mkdir(join(plan.fence.sessions, name), { recursive: true });
    }
    await writeFile(layout.held, "");
    await writeFile(layout.empty, "", { mode: 0o444 });
    // A main-tree jail reads the package store in place, as part of the main checkout, so it needs no layer for it.
    const layered = plan.fence.whole !== undefined && plan.worktree === plan.root ? plan.mirrors : [...plan.mirrors, PACKAGE_STORE];
    for (const rel of layered) {
        await mkdir(join(layerOf(plan, rel), "upper"), { recursive: true });
        await mkdir(join(layerOf(plan, rel), "work"), { recursive: true });
    }
    const host = readHostView(hostPathsFor(plan, sources));
    const args = [...sandboxArgs(plan, layout, host, sources), "--", "sh", "-c", ANCHOR_SCRIPT, "anchor", layout.held, layout.tmuxSocket];
    // allow(process-tiers): the anchor holds the namespaces a fenced turn's processes enter; detached and stamped below,
    // so the generation sweep, not netd, ends it with everything inside.
    const child = spawn("bwrap", args, {
        // Stamped, since its own group puts it out of netd's reach when the daemon dies: the next boot ends it
        // (system/boot/generation-sweep.ts), and with it everything inside.
        env: { ...process.env, ...detachedStamp("isolation-anchor") },
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        detached: true,
    });
    const lifetime = namespaceHolderLifetime(child, () => {
        child.kill("SIGKILL");
        void teardown();
    });
    try {
        if (child.pid === undefined) { throw new Error("fenced turn: could not start its sandbox"); }
        const pid = await namespaceHolderReady(child, READY, child.stdio[INFO_FD] ?? null);
        const namespace = lifetime.register(() => registerSandboxEntry(pid, { uid: SANDBOX_UID, gid: SANDBOX_GID }));
        // The turn's own streams must not keep the daemon's event loop alive after it ends.
        child.unref();
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdio[INFO_FD]?.destroy();
        return {
            pid,
            namespace,
            cwd: plan.root,
            plan,
            sandbox: layout,
            // Released, not killed: what the turn left running keeps the sandbox up until it ends (ANCHOR_SCRIPT).
            dispose: () => {
                // allow(silent-catch): the anchor ends once this file is gone; already gone is already released.
                void unlink(layout.held).catch(() => undefined);
            },
        };
    } catch (error) {
        lifetime.end();
        await teardown();
        throw error;
    }
};
