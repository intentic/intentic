import { execFile, spawn } from "node:child_process";
import { lstatSync, readlinkSync } from "node:fs";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { enginesRoot } from "../../engines/engine-store.js";
import { detachedStamp } from "../../seams/workload-stamp.js";
import { SESSION_STATE } from "../../sessions/session-store.js";
import { stateRelPath } from "../../state-paths.js";
import { queueRoot } from "../../system/resources/queue-slots.js";
import { forgetSandboxEntry, registerSandboxEntry } from "../../workload/namespace-entry.js";
import type { FencedPlacement, IsolationAnchor, IsolationPlan } from "./isolation.js";

// A fenced turn's sandbox. The turn was started by a person who holds areas, and what its checkout was cut to is only
// a fence if nothing inside the turn can widen its view again. So instead of a mount namespace the turn's root process
// could rearrange, it runs under bubblewrap: its own user (unprivileged, no capabilities, no further user namespaces),
// its own pid namespace with its own /proc, and a filesystem built up from nothing out of what is listed below.
// Anything not listed is not there.
// What it is given:
//   - the system, read-only: /usr and its links, /etc (with the password hashes and ssh host keys masked), /opt, and
//     the runtime engines the daemon installs;
//   - the conversation's own checkout at /work, read-write, with every repository's `.git` pointer masked: git
//     history holds the whole tree, so the daemon keeps committing for the turn and the turn sees files only;
//   - dependency and build mirrors from the main checkout, as overlays, only where the checkout itself has the parent
//     directory (isolation.ts planFor filters them);
//   - the conversation's own session store, the read-only reference shelf, the shared pnpm store, and the heavy-command
//     queue's lock directory, so its builds still take turns with everyone else's;
//   - a home of its own, with the shell and tool dotfiles read-only and the Claude config behind a throwaway overlay;
//   - one directory of its own (`dir`), at the same path inside and out, holding its TMPDIR, its tmux socket and its
//     terminal logs. Same path on purpose: the daemon writes the Bash tool's command files there and the turn reads
//     them, and neither has to translate a path for the other.
// The network is the container's own for now, loopback included.

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

export const hostPathsFor = (plan: IsolationPlan, sources: SandboxSources): string[] => [
    ...SYSTEM_PATHS,
    "/opt",
    sources.engines,
    ...ETC_FILES_MASKED,
    ...ETC_DIRS_MASKED,
    ...HOME_READ_ONLY.map((name) => join(sources.home, name)),
    ...HOME_OVERLAID.map((name) => join(sources.home, name)),
    join(plan.root, SHELF),
    join(plan.root, PACKAGE_STORE),
];

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
const systemArgs = (layout: SandboxLayout, host: HostView, sources: SandboxSources): string[] => {
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
    args.push(...present(host, ETC_FILES_MASKED, (path) => ["--ro-bind", layout.empty, path]));
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

// The conversation's checkout at the workspace root, its repository pointers masked, its own session store, and what
// it shares with the main checkout: the shelf read-only, the package store, and the mirrors as overlays.
const checkoutArgs = (plan: FencedPlan, layout: SandboxLayout, host: HostView): string[] => {
    const shelf = join(plan.root, SHELF);
    const store = join(plan.root, PACKAGE_STORE);
    return [
        "--bind",
        plan.worktree,
        plan.root,
        ...plan.fence.gitPointers.flatMap((rel) => ["--ro-bind", layout.empty, join(plan.root, rel, ".git")]),
        "--bind",
        plan.fence.sessions,
        join(plan.root, SESSION_STORE),
        ...(host.present.has(shelf) ? ["--ro-bind", shelf, shelf] : []),
        ...(host.present.has(store) ? ["--bind", store, store] : []),
        ...plan.mirrors.flatMap((rel) => {
            const layer = join(plan.overlays, encodeURIComponent(rel));
            return ["--overlay-src", join(plan.root, rel), "--overlay", join(layer, "upper"), join(layer, "work"), join(plan.root, rel)];
        }),
    ];
};

// The whole bwrap command line for one fenced turn, up to and excluding the command it runs. bwrap applies mounts in
// order, so a parent always comes before what is laid over it. Sources are read in the daemon's own view, before any of
// these binds, which is why a path under the workspace root names the main checkout's copy.
export const sandboxArgs = (plan: FencedPlan, layout: SandboxLayout, host: HostView, sources: SandboxSources): string[] => [
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
    "--hostname",
    "fenced",
    ...systemArgs(layout, host, sources),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/run",
    "--tmpfs",
    "/var",
    ...homeArgs(host, sources),
    "--bind",
    layout.dir,
    layout.dir,
    "--bind",
    sources.queue,
    sources.queue,
    ...checkoutArgs(plan, layout, host),
    "--chdir",
    plan.root,
    "--setenv",
    "HOME",
    sources.home,
    ...Object.entries(sandboxEnv(layout, sources.queue)).flatMap(([name, value]) => ["--setenv", name, value]),
    "--info-fd",
    String(INFO_FD),
];

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
    // allow(silent-catch): best effort, after a start that already failed; what stays behind is disk under the overlays.
    const teardown = (): Promise<void> => rm(layout.dir, { recursive: true, force: true }).catch(() => undefined);
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
    for (const rel of plan.mirrors) {
        const layer = join(plan.overlays, encodeURIComponent(rel));
        await mkdir(join(layer, "upper"), { recursive: true });
        await mkdir(join(layer, "work"), { recursive: true });
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
    if (child.pid === undefined) {
        await teardown();
        throw new Error("fenced turn: could not start its sandbox");
    }
    let pid: number;
    try {
        pid = await new Promise<number>((resolve, reject) => {
            let info = "";
            let out = "";
            let errors = "";
            let inner: number | undefined;
            let ready = false;
            const settle = (): void => {
                if (inner !== undefined && ready) {
                    resolve(inner);
                }
            };
            child.stdio[INFO_FD]?.on("data", (chunk: Buffer) => {
                info += chunk.toString();
                const match = /"child-pid"\s*:\s*(\d+)/.exec(info);
                if (match?.[1] !== undefined && inner === undefined) {
                    inner = Number(match[1]);
                    settle();
                }
            });
            child.stdout?.on("data", (chunk: Buffer) => {
                out += chunk.toString();
                if (!ready && out.includes(READY)) {
                    ready = true;
                    settle();
                }
            });
            child.stderr?.on("data", (chunk: Buffer) => {
                errors += chunk.toString();
            });
            child.on("exit", (code: number | null) =>
                reject(new Error(`fenced turn: sandbox exited ${String(code)} before it was ready: ${errors.trim()}`)),
            );
            child.on("error", reject);
        });
    } catch (error) {
        child.kill("SIGKILL");
        await teardown();
        throw error;
    }
    registerSandboxEntry(pid, { uid: SANDBOX_UID, gid: SANDBOX_GID });
    child.removeAllListeners("exit");
    child.removeAllListeners("error");
    child.once("exit", () => {
        forgetSandboxEntry(pid);
        void teardown();
    });
    // The turn's own streams must not keep the daemon's event loop alive after it ends.
    child.unref();
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.stdio[INFO_FD]?.destroy();
    return {
        pid,
        cwd: plan.root,
        plan,
        sandbox: layout,
        // Released, not killed: what the turn left running keeps the sandbox up until it ends (ANCHOR_SCRIPT).
        dispose: () => {
            // allow(silent-catch): the anchor ends once this file is gone; already gone is already released.
            void unlink(layout.held).catch(() => undefined);
        },
    };
};
