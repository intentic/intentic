import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

// Reading a live tunnel back off the machine: what address a gateway assigned, what it routed into the tunnel,
// and whether a backgrounded client is still alive. iproute2 is in the base sandbox image (not the capability
// fragment), so these work even before the VPN tooling has been rebuilt in — an interface that doesn't exist
// simply reads as absent.

const exec = promisify(execFile);

// `ip -j` (JSON) rather than scraping the human format: the shapes below are iproute2's stable JSON output.
interface IpAddrEntry {
    readonly ifname?: string;
    readonly addr_info?: readonly { readonly family?: string; readonly local?: string; readonly prefixlen?: number }[];
}
interface IpRouteEntry {
    readonly dst?: string;
    readonly dev?: string;
}

const ipJson = async <T>(args: readonly string[]): Promise<T[]> => {
    const { stdout } = await exec("ip", ["-j", ...args]).catch(() => ({ stdout: "" }));
    if (stdout.trim() === "") {
        return [];
    }
    try {
        const parsed: unknown = JSON.parse(stdout);
        return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
        // A build of iproute2 without JSON support prints its usage here — no address is a fair reading.
        return [];
    }
};

// True once the kernel has the interface, whatever its state — the first observable step of a dial.
export const interfaceExists = async (name: string): Promise<boolean> => (await ipJson<IpAddrEntry>(["addr", "show", "dev", name])).length > 0;

// The IPv4 address the gateway assigned, as "10.212.134.200/32". Undefined while the interface exists but has
// not been configured yet — which is exactly the "connecting" window.
export const interfaceAddress = async (name: string): Promise<string | undefined> => {
    const [entry] = await ipJson<IpAddrEntry>(["addr", "show", "dev", name]);
    const info = entry?.addr_info?.find((candidate) => candidate.family === "inet");
    return info?.local === undefined ? undefined : `${info.local}/${info.prefixlen ?? 32}`;
};

// The CIDRs routed into the tunnel. iproute2 reports a default route as "default", which is renamed to the
// CIDR it means so the UI can say "full tunnel" from the data alone.
export const interfaceRoutes = async (name: string): Promise<string[]> => {
    const entries = await ipJson<IpRouteEntry>(["route", "show", "dev", name]);
    return entries.flatMap((entry) => (entry.dst === undefined ? [] : [entry.dst === "default" ? "0.0.0.0/0" : entry.dst]));
};

// The resolvers currently in effect. A tunnel that pushed DNS has rewritten /etc/resolv.conf (openconnect's
// vpnc-script and wg-quick's resolvconf both do), so this is the honest answer to "where does the sandbox
// resolve names now" — it is reported per link only while that link is the one that's up.
export const activeResolvers = async (): Promise<string[]> => {
    const content = await readFile("/etc/resolv.conf", "utf8").catch(() => "");
    return content
        .split("\n")
        .flatMap((line) => /^\s*nameserver\s+(\S+)/.exec(line)?.[1] ?? [])
        .slice(0, 4);
};

// Whether a pid from a client's pidfile is still a live process of that client. The cmdline check is what makes
// this safe: a recycled pid belonging to something else must not read as a connected tunnel.
export const processAlive = async (pid: number, expectedCommand: string): Promise<boolean> => {
    const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => undefined);
    return cmdline !== undefined && cmdline.includes(expectedCommand);
};

// The pid a client wrote to its pidfile, or undefined when the file is absent/garbage (never dialled, or the
// client cleaned up after itself).
export const readPid = async (path: string): Promise<number | undefined> => {
    const raw = await readFile(path, "utf8").catch(() => undefined);
    const pid = raw === undefined ? Number.NaN : Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
};

// True when the executable is not on PATH — the pre-rebuild state. ENOENT on spawn is the only signal that
// means "absent"; a non-zero exit (a usage error from `--version`) still proves it exists.
export const toolMissing = async (command: string, versionArgs: readonly string[] = ["--version"]): Promise<boolean> =>
    exec(command, [...versionArgs]).then(
        () => false,
        (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );

// The tail of a client's own log, for a failure message the user has to read (a rejected password, an
// untrusted certificate and its expected fingerprint, a refused gateway).
export const logTail = async (path: string, lines = 12): Promise<string> => {
    const content = await readFile(path, "utf8").catch(() => "");
    return content
        .split("\n")
        .filter((line) => line.trim() !== "")
        .slice(-lines)
        .join("\n");
};
