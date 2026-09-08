import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { parentPid } from "../platform/resources/proc-stat.js";

// Discovers every listening TCP socket via procfs, no lsof/ss dependency. The only way to see ports bound outside the
// managed-process registry: a terminal's dev servers, an agent's ad-hoc process, a docker-proxy.

// The address the proxy must dial to reach a listener; not always 127.0.0.1, a `localhost` bind can land on IPv6-only
// (Vite does this).
export type LoopbackHost = "127.0.0.1" | "::1";

export interface ListeningPort {
    readonly port: number;
    readonly host: LoopbackHost;
    // Whether dialing `host` actually reaches it; false for a loopback alias like Docker's 127.0.0.11 DNS.
    readonly forwardable: boolean;
    readonly pid?: number;
    readonly command?: string;
    readonly cwd?: string;
    // The tmux session it runs in, watchable/killable by the user; absent when nothing in its ancestry is a pane.
    readonly session?: string;
}

// Walks a socket's owner up its parents to the first tmux pane root, since the launched process (pnpm dev -> turbo ->
// vite) is rarely the listening one. Bounded and visited-guarded against a raced stat file looping the walk.
const ANCESTRY_LIMIT = 64;

// Annotates each listener with the tmux session it descends from; `panes` maps a pane's root pid to its session. An
// empty map annotates nothing.
export const withOwningSessions = async (
    listeners: readonly ListeningPort[],
    panes: ReadonlyMap<number, string>,
    procRoot = "/proc",
): Promise<ListeningPort[]> => {
    if (panes.size === 0) {
        return [...listeners];
    }
    // One read per pid for the whole scan; sibling dev servers under one pnpm dev share ancestors.
    const parents = new Map<number, number | undefined>();
    const parentOf = async (pid: number): Promise<number | undefined> => {
        if (!parents.has(pid)) {
            parents.set(pid, parentPid(await readFile(join(procRoot, String(pid), "stat"), "utf8").catch(() => "")));
        }
        return parents.get(pid);
    };
    return Promise.all(
        listeners.map(async (listener) => {
            const visited = new Set<number>();
            let pid = listener.pid;
            for (let hop = 0; pid !== undefined && hop < ANCESTRY_LIMIT && !visited.has(pid); hop++) {
                const session = panes.get(pid);
                if (session !== undefined) {
                    return { ...listener, session };
                }
                visited.add(pid);
                pid = await parentOf(pid);
            }
            return listener;
        }),
    );
};

// Resolves a hex bind address to the dial host and reachability; a non-loopback bind (docker bridge) is dropped.
// Wildcard and exact 127.0.0.1/::1 are forwardable; another 127/8 alias is listed but not-forwardable.
const loopbackBind = (hexAddress: string): { host: LoopbackHost; forwardable: boolean } | undefined => {
    if (hexAddress.length === 8) {
        if (hexAddress === "00000000" || hexAddress === "0100007F") {
            return { host: "127.0.0.1", forwardable: true }; // 0.0.0.0 or 127.0.0.1
        }
        return hexAddress.endsWith("7F") ? { host: "127.0.0.1", forwardable: false } : undefined; // 127/8 alias vs non-loopback
    }
    if (hexAddress === "0".repeat(32)) {
        return { host: "127.0.0.1", forwardable: true }; // ::
    }
    return hexAddress === `${"0".repeat(24)}01000000` ? { host: "::1", forwardable: true } : undefined; // ::1
};

// Whitespace-split fields of a /proc/net/tcp{,6} LISTEN row: [sl, local_address, rem_address, st, tx:rx, tr:tm,
// retrnsmt, uid, timeout, inode, ...]; st 0A means LISTEN.
const parseListeners = (table: string): { port: number; host: LoopbackHost; forwardable: boolean; address: string; inode: string }[] => {
    const listeners: { port: number; host: LoopbackHost; forwardable: boolean; address: string; inode: string }[] = [];
    for (const line of table.split("\n").slice(1)) {
        const fields = line.trim().split(/\s+/);
        const local = fields[1]?.split(":");
        const inode = fields[9];
        if (fields[3] !== "0A" || local?.[0] === undefined || local[1] === undefined || inode === undefined) {
            continue;
        }
        const address = local[0].toUpperCase();
        const bind = loopbackBind(address);
        if (bind === undefined) {
            continue;
        }
        listeners.push({ port: Number.parseInt(local[1], 16), host: bind.host, forwardable: bind.forwardable, address, inode });
    }
    return listeners;
};

// Naming what a listener is (port-identity.ts) needs the workspace root and extension process index, facts this scan
// doesn't have, so it takes them as arguments there.

// Maps wanted socket inodes to owning pids by walking every fd table (what `ss -p` does); a vanished process or
// unreadable fd is skipped. First claimant wins for a fork-shared socket.
const resolvePids = async (procRoot: string, wanted: ReadonlySet<string>): Promise<Map<string, number>> => {
    const owners = new Map<string, number>();
    const entries = await readdir(procRoot).catch(() => [] as string[]);
    await Promise.all(
        entries
            .filter((entry) => /^\d+$/.test(entry))
            .map(async (entry) => {
                const pid = Number(entry);
                const fdDir = join(procRoot, entry, "fd");
                const fds = await readdir(fdDir).catch(() => [] as string[]);
                await Promise.all(
                    fds.map(async (fd) => {
                        const target = await readlink(join(fdDir, fd)).catch(() => undefined);
                        const inode = target?.match(/^socket:\[(\d+)\]$/)?.[1];
                        if (inode !== undefined && wanted.has(inode) && !owners.has(inode)) {
                            owners.set(inode, pid);
                        }
                    }),
                );
            }),
    );
    return owners;
};

// Docker's embedded DNS answers outside the PID namespace, the one unowned listener nameable by address.
const DOCKER_EMBEDDED_DNS_ADDRESS = "0B00007F"; // 127.0.0.11, /proc/net/tcp little-endian hex

// Every forwardable TCP port in the sandbox's netns, attributed to its owning process where procfs allows. procRoot is
// injectable for test fixtures; dual-stack listeners collapse to one row.
export const scanListeningPorts = async (procRoot = "/proc"): Promise<ListeningPort[]> => {
    const tables = await Promise.all(["tcp", "tcp6"].map((table) => readFile(join(procRoot, "net", table), "utf8").catch(() => "")));
    const byPort = new Map<number, { port: number; host: LoopbackHost; forwardable: boolean; address: string; inode: string }>();
    for (const listener of tables.flatMap(parseListeners)) {
        const existing = byPort.get(listener.port);
        // A dual-stack port collapses to one row, preferring the 127.0.0.1-dialable side.
        if (existing === undefined || (existing.host === "::1" && listener.host === "127.0.0.1")) {
            byPort.set(listener.port, listener);
        }
    }
    const owners = await resolvePids(procRoot, new Set([...byPort.values()].map((listener) => listener.inode)));
    return Promise.all(
        [...byPort.values()]
            .toSorted((a, b) => a.port - b.port)
            .map(async ({ port, host, forwardable, address, inode }) => {
                const pid = owners.get(inode);
                if (pid === undefined) {
                    // Unowned in /proc/*/fd, likely outside this PID namespace; Docker's DNS is still nameable by
                    // address.
                    return address === DOCKER_EMBEDDED_DNS_ADDRESS
                        ? { port, host, forwardable, command: "Docker embedded DNS" }
                        : { port, host, forwardable };
                }
                // cmdline reads empty for kernel threads or a cleared argv, falling back to comm (truncated to 15
                // chars). cwd needs the daemon's own-user privilege; either read failing just drops that annotation.
                const cmdline = await readFile(join(procRoot, String(pid), "cmdline"), "utf8").catch(() => "");
                const command =
                    cmdline.split("\0").filter(Boolean).join(" ") ||
                    (await readFile(join(procRoot, String(pid), "comm"), "utf8").catch(() => "")).trim();
                const cwd = await readlink(join(procRoot, String(pid), "cwd")).catch(() => undefined);
                const listener: { port: number; host: LoopbackHost; forwardable: boolean; pid: number; command?: string; cwd?: string } = {
                    port,
                    host,
                    forwardable,
                    pid,
                };
                if (command !== "") {
                    listener.command = command;
                }
                if (cwd !== undefined) {
                    listener.cwd = cwd;
                }
                return listener;
            }),
    );
};
