import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

// Discovers every listening TCP socket in the sandbox by reading procfs directly — no lsof/ss dependency, a
// handful of file reads per scan, cheap enough to run on demand per /ports request. This is the generic
// complement to the managed-process registry: anything run in a terminal (a turbo TUI fanning out dev servers,
// an agent's ad-hoc process, a docker-proxy for a published container) binds ports the daemon never assigned,
// and this scan is the only way to see them.

// The loopback address the proxy must DIAL to reach a listener. Not always 127.0.0.1: a server that binds
// `localhost` can land on IPv6 loopback only (Vite does exactly this — [::1]:<port> refuses IPv4), so the
// dialable family is a per-listener fact the scan records and the forward/proxy honor.
export type LoopbackHost = "127.0.0.1" | "::1";

export interface ListeningPort {
    readonly port: number;
    readonly host: LoopbackHost;
    readonly pid?: number;
    readonly command?: string;
    readonly cwd?: string;
}

// A /proc/net/tcp{,6} LISTEN row's local address, hex-encoded (IPv4 little-endian), resolved to the loopback
// address that reaches it — or undefined for a bind the proxy can't reach (a docker bridge address). Wildcard
// binds (0.0.0.0 and ::, which accepts v4-mapped connections on Linux) dial as 127.0.0.1; a v6-loopback-only
// bind must be dialed at ::1.
const dialHost = (hexAddress: string): LoopbackHost | undefined => {
    if (hexAddress.length === 8) {
        return hexAddress === "00000000" || hexAddress.endsWith("7F") ? "127.0.0.1" : undefined; // 0.0.0.0 or 127/8
    }
    if (hexAddress === "0".repeat(32)) {
        return "127.0.0.1"; // ::
    }
    return hexAddress === `${"0".repeat(24)}01000000` ? "::1" : undefined; // ::1
};

// LISTEN rows from one /proc/net/tcp{,6} table: whitespace-split fields are
// [sl, local_address, rem_address, st, tx:rx, tr:tm, retrnsmt, uid, timeout, inode, …]; st 0A is LISTEN.
const parseListeners = (table: string): { port: number; host: LoopbackHost; inode: string }[] => {
    const listeners: { port: number; host: LoopbackHost; inode: string }[] = [];
    for (const line of table.split("\n").slice(1)) {
        const fields = line.trim().split(/\s+/);
        const local = fields[1]?.split(":");
        const inode = fields[9];
        if (fields[3] !== "0A" || local?.[0] === undefined || local[1] === undefined || inode === undefined) {
            continue;
        }
        const host = dialHost(local[0].toUpperCase());
        if (host === undefined) {
            continue;
        }
        listeners.push({ port: Number.parseInt(local[1], 16), host, inode });
    }
    return listeners;
};

// Map the wanted socket inodes to their owning pids by walking every process's fd table — the same resolution
// `ss -p` performs. Processes vanish mid-scan and some fds aren't readable; both just skip. First claimant
// wins (a socket shared across forks belongs to whichever pid enumerates first — good enough for labeling).
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

// Every TCP port listening in the sandbox's network namespace that the preview proxy could forward, each
// attributed to its owning process where procfs allows. `procRoot` is injectable so tests run against a
// fixture tree. Dual-stack listeners (the same port on tcp and tcp6) collapse to one row.
export const scanListeningPorts = async (procRoot = "/proc"): Promise<ListeningPort[]> => {
    const tables = await Promise.all(["tcp", "tcp6"].map((table) => readFile(join(procRoot, "net", table), "utf8").catch(() => "")));
    const byPort = new Map<number, { port: number; host: LoopbackHost; inode: string }>();
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
            .map(async ({ port, host, inode }) => {
                const pid = owners.get(inode);
                if (pid === undefined) {
                    return { port, host };
                }
                // cmdline is NUL-separated argv; empty for kernel threads. cwd needs the same-user privilege the
                // daemon (root in the container) has — either read failing just drops the annotation.
                const cmdline = await readFile(join(procRoot, String(pid), "cmdline"), "utf8").catch(() => "");
                const command = cmdline.split("\0").filter(Boolean).join(" ");
                const cwd = await readlink(join(procRoot, String(pid), "cwd")).catch(() => undefined);
                const listener: { port: number; host: LoopbackHost; pid: number; command?: string; cwd?: string } = { port, host, pid };
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
