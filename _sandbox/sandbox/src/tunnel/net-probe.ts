import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";

// Reads a live tunnel back off the machine: address, routes, and whether a backgrounded client is alive. iproute2 ships
// in the base image, so this works before VPN tooling is rebuilt in; a missing interface just reads as absent.

const exec = promisify(execFile);

// `ip -j` (JSON) rather than the human format: these shapes are iproute2's stable JSON output.
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
        // A build of iproute2 without JSON support prints usage here; no address is a fair reading.
        return [];
    }
};

// IPv4 address the gateway assigned, e.g. "10.212.134.200/32"; undefined while an interface exists but isn't configured
// yet.
export const interfaceAddress = async (name: string): Promise<string | undefined> => {
    const [entry] = await ipJson<IpAddrEntry>(["addr", "show", "dev", name]);
    const info = entry?.addr_info?.find((candidate) => candidate.family === "inet");
    return info?.local === undefined ? undefined : `${info.local}/${info.prefixlen ?? 32}`;
};

// CIDRs routed into the tunnel; iproute2's "default" route is renamed to 0.0.0.0/0 so a full tunnel reads from the data
// alone.
export const interfaceRoutes = async (name: string): Promise<string[]> => {
    const entries = await ipJson<IpRouteEntry>(["route", "show", "dev", name]);
    return entries.flatMap((entry) => (entry.dst === undefined ? [] : [entry.dst === "default" ? "0.0.0.0/0" : entry.dst]));
};

// Resolvers currently in effect, read from /etc/resolv.conf as a tunnel's DNS push rewrites it; reported only while
// that link is up.
export const activeResolvers = async (): Promise<string[]> => {
    const content = await readFile("/etc/resolv.conf", "utf8").catch(() => "");
    return content
        .split("\n")
        .flatMap((line) => /^\s*nameserver\s+(\S+)/.exec(line)?.[1] ?? [])
        .slice(0, 4);
};

// Whether a pidfile's pid is still that client; the cmdline check stops a recycled pid from reading as a connected
// tunnel.
export const processAlive = async (pid: number, expectedCommand: string): Promise<boolean> => {
    const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => undefined);
    return cmdline !== undefined && cmdline.includes(expectedCommand);
};

// Pid a client wrote to its pidfile, or undefined when absent or garbage.
export const readPid = async (path: string): Promise<number | undefined> => {
    const raw = await readFile(path, "utf8").catch(() => undefined);
    const pid = raw === undefined ? Number.NaN : Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
};

// Two-step every driver does before trusting a pidfile: read it, then confirm the pid is still `command`
// (tor/openvpn/openconnect); without the second check a recycled pid reads as connected.
export const livePid = async (pidFile: string, command: string): Promise<number | undefined> => {
    const pid = await readPid(pidFile);
    return pid !== undefined && (await processAlive(pid, command)) ? pid : undefined;
};

// Stops the client and forgets its pidfile. TERM, not KILL, lets the client tear down its own interface and routes; the
// pidfile is removed either way so a stale one can't fool the next dial.
export const halt = async (pidFile: string, command: string): Promise<void> => {
    const pid = await livePid(pidFile, command);
    if (pid !== undefined) {
        await exec("kill", ["-TERM", String(pid)]).catch(() => undefined);
    }
    await rm(pidFile, { force: true });
};

// True when the executable is off PATH: ENOENT on spawn is the only signal for absent, a non-zero exit still proves it
// exists.
export const toolMissing = async (command: string, versionArgs: readonly string[] = ["--version"]): Promise<boolean> =>
    exec(command, [...versionArgs]).then(
        () => false,
        (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );

// Tail of a client's own log, for a failure message the user has to read.
export const logTail = async (path: string, lines = 12): Promise<string> => {
    const content = await readFile(path, "utf8").catch(() => "");
    return content
        .split("\n")
        .filter((line) => line.trim() !== "")
        .slice(-lines)
        .join("\n");
};
