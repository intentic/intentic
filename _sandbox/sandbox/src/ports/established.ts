import { readFile } from "node:fs/promises";

// WHO IS CONNECTED TO A PORT RIGHT NOW, from the kernel's own socket tables: the cheap question a full listener scan
// (port-scan.ts walks every process's fds) is far too heavy to ask once a minute. A browser with a workspace app open
// holds a connection to it (its page, its hot-reload socket), whichever way it came: the preview proxy relaying it, a
// port the owner's computer forwards to its own localhost, or a curl in a terminal.

const TABLES = ["/proc/net/tcp", "/proc/net/tcp6"] as const;
// The kernel's TCP_ESTABLISHED, as the `st` column spells it.
const ESTABLISHED = "01";

// The local ports of every established connection in one table's text. Pure: the header line and anything that is
// not a socket row are skipped.
export const establishedPortsIn = (table: string): Set<number> => {
    const ports = new Set<number>();
    for (const line of table.split("\n")) {
        // sl local_address rem_address st ...
        const [, local, , state] = line.trim().split(/\s+/u);
        if (state !== ESTABLISHED || local === undefined) {
            continue;
        }
        const port = Number.parseInt(local.slice(local.lastIndexOf(":") + 1), 16);
        if (Number.isInteger(port) && port > 0) {
            ports.add(port);
        }
    }
    return ports;
};

// Both tables; one that cannot be read (no IPv6) counts as no connections.
export const establishedLocalPorts = async (read: (path: string) => Promise<string> = (path) => readFile(path, "utf8")): Promise<Set<number>> => {
    const tables = await Promise.all(TABLES.map((path) => read(path).catch(() => "")));
    return new Set(tables.flatMap((table) => [...establishedPortsIn(table)]));
};

// Whether any of `ports` has a connection open to it.
export const anyConnected = async (ports: readonly number[], read?: (path: string) => Promise<string>): Promise<boolean> => {
    if (ports.length === 0) {
        return false;
    }
    const open = await establishedLocalPorts(read);
    return ports.some((port) => open.has(port));
};
