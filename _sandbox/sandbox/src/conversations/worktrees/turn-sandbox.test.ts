import { HISTORY_ROOT, STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import { type FencedPlan, type HostView, SANDBOX_UID, sandboxArgs, sandboxEnv, sandboxLayout, type SandboxSources, shelfFolders } from "./turn-sandbox.js";

// Pins what a fenced turn's sandbox is built from, as an argv, without a kernel: the fence is only as good as this
// list, and a wrong entry here is a folder handed back silently. The real sandbox is run in the integration suite.

const plan: FencedPlan = {
    worktree: `${HISTORY_ROOT}/worktrees/abc`,
    root: WORKSPACE_ROOT,
    mirrors: ["node_modules", "support/web/dist"],
    overlays: `${HISTORY_ROOT}/overlays/abc`,
    fence: {
        folders: ["support/web", "refs/sdk"],
        hidden: [STATE_DIR, "finance"],
        sessions: `${HISTORY_ROOT}/conversations/abc/sessions`,
        gitPointers: ["", "intent"],
    },
};
const layout = sandboxLayout(`${HISTORY_ROOT}/overlays/abc/sandbox-1`);
const sources: SandboxSources = { home: "/root", engines: `${HISTORY_ROOT}/engines`, queue: "/tmp/intentic-queue" };
const host: HostView = {
    links: new Map([
        ["/bin", "usr/bin"],
        ["/lib", "usr/lib"],
    ]),
    present: new Set([
        "/bin",
        "/lib",
        "/opt",
        `${HISTORY_ROOT}/engines`,
        "/etc/shadow",
        "/etc/ssh",
        "/root/.bashrc",
        "/root/.gitconfig",
        "/root/.claude",
        `${WORKSPACE_ROOT}/refs/sdk`,
        `${WORKSPACE_ROOT}/.pnpm-store`,
    ]),
};
const args = sandboxArgs(plan, layout, host, sources);

// Every `--<flag> a b` triple as [a, b], for the mount flags that take a source and a destination.
const pairs = (flag: string): [string, string][] =>
    args.flatMap((arg, at): [string, string][] => (arg === flag ? [[args[at + 1] ?? "", args[at + 2] ?? ""]] : []));

test("the turn runs as an unprivileged user in namespaces of its own, holding no capability and unable to make more", () => {
    for (const flag of ["--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--disable-userns"]) {
        expect(args).toContain(flag);
    }
    expect(args.slice(args.indexOf("--uid"), args.indexOf("--uid") + 2)).toEqual(["--uid", String(SANDBOX_UID)]);
    expect(args.slice(args.indexOf("--cap-drop"), args.indexOf("--cap-drop") + 2)).toEqual(["--cap-drop", "ALL"]);
});

test("the checkout is the workspace root, read-write, and every repository pointer in it reads as empty", () => {
    expect(pairs("--bind")).toContainEqual([plan.worktree, WORKSPACE_ROOT]);
    const masked = pairs("--ro-bind").filter(([source]) => source === layout.empty);
    expect(masked.map(([, target]) => target)).toEqual(expect.arrayContaining([`${WORKSPACE_ROOT}/.git`, `${WORKSPACE_ROOT}/intent/.git`]));
});

test("nothing of the daemon's history is bound but the turn's own pieces and the read-only engines", () => {
    const bound = new Set([...pairs("--bind"), ...pairs("--ro-bind")].map(([source]) => source).filter((source) => source.startsWith(HISTORY_ROOT)));
    // The sandbox's own dir, and the empty file in it every mask reads from.
    expect([...bound].toSorted()).toEqual([`${HISTORY_ROOT}/engines`, plan.fence.sessions, layout.dir, layout.empty, plan.worktree].toSorted());
    expect(pairs("--ro-bind")).toContainEqual([`${HISTORY_ROOT}/engines`, `${HISTORY_ROOT}/engines`]);
    // The main checkout is never bound whole; only the shelf and the layered mirrors read from it, the shelf read-only.
    expect([...pairs("--bind"), ...pairs("--ro-bind")].map(([source]) => source)).not.toContain(WORKSPACE_ROOT);
    expect(pairs("--ro-bind")).toContainEqual([`${WORKSPACE_ROOT}/refs/sdk`, `${WORKSPACE_ROOT}/refs/sdk`]);
});

// Personas and areas grant shelf folders one by one (`refs/sdk`); the rest of the shelf is not the fence's.
test("the shelf comes in only as far as the fence names folders on it", () => {
    const shelf = [...pairs("--bind"), ...pairs("--ro-bind")].filter(([source]) => source.startsWith(`${WORKSPACE_ROOT}/refs`));
    expect(shelf).toEqual([[`${WORKSPACE_ROOT}/refs/sdk`, `${WORKSPACE_ROOT}/refs/sdk`]]);
    expect(shelfFolders(["refs", "refs/sdk", "support", "refsx"])).toEqual(["refs"]);
    expect(shelfFolders(["support"])).toEqual([]);
});

// The turn is the owner of every root-owned file it can write, and the store's files are hard links into every
// checkout's dependencies: a writable store would be a write into the main checkout's node_modules.
test("the package store is read through a layer of the conversation's own, never bound writable", () => {
    expect([...pairs("--bind"), ...pairs("--ro-bind")].map(([source]) => source)).not.toContain(`${WORKSPACE_ROOT}/.pnpm-store`);
    const overlays = args.flatMap((arg, at) => (arg === "--overlay" ? [args.slice(at - 1, at + 4)] : []));
    expect(overlays).toContainEqual([
        `${WORKSPACE_ROOT}/.pnpm-store`,
        "--overlay",
        `${plan.overlays}/.pnpm-store/upper`,
        `${plan.overlays}/.pnpm-store/work`,
        `${WORKSPACE_ROOT}/.pnpm-store`,
    ]);
});

// Covered right after the checkout is bound, so nothing the sandbox later places inside a covered directory (the
// session store under `.intentic`) is hidden by it.
test("every directory the fence does not reach is covered by an empty layer before anything is placed inside it", () => {
    const checkout = args.findIndex((arg, at) => arg === "--bind" && args[at + 1] === plan.worktree);
    const covers = [`${WORKSPACE_ROOT}/.intentic`, `${WORKSPACE_ROOT}/finance`].map((target) => args.findIndex((arg, at) => arg === "--tmpfs" && args[at + 1] === target));
    const sessions = args.findIndex((arg, at) => arg === "--bind" && args[at + 1] === plan.fence.sessions);
    for (const cover of covers) {
        expect(cover).toBeGreaterThan(checkout);
        expect(cover).toBeLessThan(sessions);
    }
});

test("the conversation's own session store stands where the runtime's links point", () => {
    expect(pairs("--bind")).toContainEqual([plan.fence.sessions, `${WORKSPACE_ROOT}/.intentic/records/sessions/claude`]);
});

test("mirrors are overlays over the main checkout with their writes kept in the conversation's layer", () => {
    const overlays = args.flatMap((arg, at) => (arg === "--overlay" ? [args.slice(at - 1, at + 4)] : []));
    expect(overlays).toContainEqual([
        `${WORKSPACE_ROOT}/node_modules`,
        "--overlay",
        `${plan.overlays}/node_modules/upper`,
        `${plan.overlays}/node_modules/work`,
        `${WORKSPACE_ROOT}/node_modules`,
    ]);
    // And the package store's.
    expect(overlays).toHaveLength(plan.mirrors.length + 1);
});

test("the home is empty but for the listed dotfiles, and the Claude config is read through a throwaway layer", () => {
    const tmpfs = args.flatMap((arg, at) => (arg === "--tmpfs" ? [args[at + 1]] : []));
    expect(tmpfs).toEqual(expect.arrayContaining(["/root", "/tmp", "/run", "/etc/ssh"]));
    const home = pairs("--ro-bind").filter(([source]) => source.startsWith("/root/"));
    expect(home).toEqual([
        ["/root/.bashrc", "/root/.bashrc"],
        ["/root/.gitconfig", "/root/.gitconfig"],
    ]);
    expect(args.slice(args.indexOf("--overlay-src"), args.indexOf("--overlay-src") + 4)).toEqual(["--overlay-src", "/root/.claude", "--tmp-overlay", "/root/.claude"]);
});

test("the system is read-only, merged-/usr links are links, and password hashes read as empty", () => {
    expect(pairs("--ro-bind")).toContainEqual(["/usr", "/usr"]);
    expect(pairs("--ro-bind")).toContainEqual(["/etc", "/etc"]);
    expect(pairs("--ro-bind")).toContainEqual([layout.empty, "/etc/shadow"]);
    expect(pairs("--symlink")).toEqual([
        ["usr/bin", "/bin"],
        ["usr/lib", "/lib"],
    ]);
    // An absent path is left out, never bound as an empty stand-in.
    expect(args).not.toContain("/lib64");
});

test("every entrant is told the sandbox's own temp dir, tmux server, terminal logs and the shared queue", () => {
    expect(sandboxEnv(layout, sources.queue)).toEqual({
        TMPDIR: layout.tmp,
        INTENTIC_TMUX_SOCKET: layout.tmuxSocket,
        INTENTIC_TERMINAL_LOGS_DIR: layout.terminalLogs,
        INTENTIC_QUEUE_DIR: sources.queue,
    });
    for (const [name, value] of Object.entries(sandboxEnv(layout, sources.queue))) {
        expect(args.join("\0")).toContain(["--setenv", name, value].join("\0"));
    }
    // Its own dir sits at the same path inside and out, so a command file the daemon writes is the one the turn reads.
    expect(pairs("--bind")).toContainEqual([layout.dir, layout.dir]);
});
