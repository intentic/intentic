import { execFile, spawn } from "node:child_process";
import { open, mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import type { FortinetVpnConfig, VpnConfig } from "@intentic/sandbox-contract";
import { activeResolvers, interfaceAddress, interfaceRoutes, logTail, processAlive, readPid, toolMissing } from "./net-probe.js";
import type { VpnDialOptions, VpnDriver, VpnProbe } from "./vpn-driver.js";
import { interfaceName, logPath, pidPath, vpnDir } from "./vpn-paths.js";

// A FortiGate SSL-VPN, what FortiClient's <sslvpn> connections speak, dialled with openconnect's fortinet
// protocol. openconnect rather than openfortivpn because it routes over a tun device instead of spawning pppd:
// it needs exactly the /dev/net/tun + NET_ADMIN grant the vpn capability already carries, whereas pppd would
// additionally need /dev/ppp, which the rebuild executors' runtime allowlist deliberately does not include.
//
// openconnect daemonizes itself (--background) only AFTER the tunnel is established, so the foreground exit
// code is the dial's verdict: 0 means connected, anything else means the log holds a message the user needs.

const exec = promisify(execFile);
const config = (raw: VpnConfig): FortinetVpnConfig => raw as FortinetVpnConfig;

// A dial that hasn't resolved by now is wedged (an unreachable gateway with no RST, a prompt nothing will
// answer). Killed rather than left to hold the connect stream open forever.
const DIAL_TIMEOUT_MS = 90_000;

const fortinetGateway = (raw: FortinetVpnConfig): string => `${raw.server}:${raw.port}`;

// openconnect's argv. Credentials never appear here, the password and any OTP ride stdin, so the full command
// is safe to log, and `ps` in the sandbox never shows a VPN password.
const openconnectArgs = (id: string, raw: FortinetVpnConfig): string[] => [
    "--protocol=fortinet",
    "--background",
    `--pid-file=${pidPath(id)}`,
    `--interface=${interfaceName(id)}`,
    `--user=${raw.username}`,
    "--passwd-on-stdin",
    ...(raw.realm === undefined ? [] : [`--usergroup=${raw.realm}`]),
    // A self-signed / private-CA gateway: pin the digest the user copied out of openconnect's own refusal
    // instead of trusting a CA that isn't there. Absent ⇒ ordinary CA validation.
    ...(raw.trustedCert === undefined ? [] : [`--servercert=${raw.trustedCert}`]),
    fortinetGateway(raw),
];

// What openconnect reads from stdin, in prompt order: the password, then the 2FA code when the gateway asks
// for one. A trailing newline on each is what makes openconnect treat them as complete answers.
const dialStdin = (password: string, otp: string | undefined): string => (otp === undefined ? `${password}\n` : `${password}\n${otp}\n`);

// The line worth showing when a dial fails. openconnect's untrusted-certificate refusal prints the exact
// --servercert value to pin, which is the one message a user must see verbatim to recover.
const dialFailureHint = (log: string): string | undefined => {
    const pin = /--servercert\s+(sha256:[0-9a-f]+)/i.exec(log)?.[1];
    if (pin !== undefined) {
        return `The gateway's certificate is not signed by a trusted CA. Re-add this VPN with "Trusted certificate" set to ${pin} to pin it.`;
    }
    if (/failed to obtain WebVPN cookie|Login failed|authentication failed|Invalid username or password/i.test(log)) {
        return "The gateway rejected the sign-in. Check the username and password, and if this gateway uses a token, supply the one-time code with the connect.";
    }
    if (/token|two[- ]factor|challenge/i.test(log)) {
        return "The gateway asked for a one-time code. Connect again with a current 2FA code.";
    }
    return undefined;
};

// Run openconnect to completion in the FOREGROUND, with its output going straight to a log file rather than a
// pipe: the backgrounded grandchild inherits those descriptors and keeps writing to the log, while the pipe
// this promise waits on is only stdin, so the parent's exit is observable instead of blocking on a fd the
// daemon would still hold open.
const dial = async (id: string, raw: FortinetVpnConfig, otp: string | undefined): Promise<number> => {
    const handle = await open(logPath(id), "w", 0o600);
    try {
        return await new Promise<number>((resolve, reject) => {
            const child = spawn("openconnect", openconnectArgs(id, raw), { stdio: ["pipe", handle.fd, handle.fd] });
            const timer = setTimeout(() => child.kill("SIGTERM"), DIAL_TIMEOUT_MS);
            child.on("error", (error) => {
                clearTimeout(timer);
                reject(error);
            });
            child.on("exit", (code, signal) => {
                clearTimeout(timer);
                // A signalled exit is the timeout above; report it as a distinct non-zero rather than 0.
                resolve(signal !== null ? 124 : (code ?? 1));
            });
            // stdio[0] is "pipe" above, so stdin is always a stream here, the guard keeps the compiler honest
            // about spawn's general signature rather than covering a reachable case.
            child.stdin?.end(dialStdin(raw.password, otp));
        });
    } finally {
        await handle.close();
    }
};

// The pid openconnect left behind, but only when it is still a live openconnect, a recycled pid must never
// read as a connected tunnel.
const livePid = async (id: string): Promise<number | undefined> => {
    const pid = await readPid(pidPath(id));
    return pid !== undefined && (await processAlive(pid, "openconnect")) ? pid : undefined;
};

export const fortinetDriver: VpnDriver = {
    gateway: (raw) => fortinetGateway(config(raw)),
    // Nothing to persist: the credentials live in the capability manifest (already 0600 and denylisted) and
    // reach openconnect over stdin at dial time, so there is no second copy of the password on disk.
    write: async () => {
        await mkdir(vpnDir(), { recursive: true, mode: 0o700 });
    },
    erase: async (id) => {
        await rm(pidPath(id), { force: true });
        await rm(logPath(id), { force: true });
    },
    missingTool: async () => ((await toolMissing("openconnect")) ? "openconnect" : undefined),
    async *connect(id, raw, options: VpnDialOptions) {
        const fortinet = config(raw);
        if ((await livePid(id)) !== undefined) {
            yield { kind: "log", message: `${id} is already connected to ${fortinetGateway(fortinet)}.` };
            return;
        }
        await mkdir(vpnDir(), { recursive: true, mode: 0o700 });
        // Stale pidfile from a client that was killed rather than shut down, clear it so a failed dial below
        // can't be read as the previous run still being up.
        await rm(pidPath(id), { force: true });
        yield { kind: "log", message: `Dialling ${fortinetGateway(fortinet)} as ${fortinet.username}…` };
        const code = await dial(id, fortinet, options.otp);
        if (code !== 0) {
            const log = await logTail(logPath(id));
            const hint = dialFailureHint(log);
            throw new Error(
                [`openconnect could not connect ${id} (exit ${code}).`, hint, log === "" ? undefined : log]
                    .filter((part) => part !== undefined)
                    .join("\n"),
            );
        }
        yield { kind: "log", message: `Connected ${id} on ${interfaceName(id)}. Routes pushed by the gateway now ride the tunnel.` };
    },
    disconnect: async (id) => {
        const pid = await livePid(id);
        if (pid !== undefined) {
            // SIGTERM is openconnect's clean shutdown: it tears the routes down through vpnc-script and removes
            // its own pidfile. Killing it outright would strand the routing table.
            await exec("kill", ["-TERM", String(pid)]).catch(() => undefined);
        }
        await rm(pidPath(id), { force: true });
    },
    probe: async (id): Promise<VpnProbe> => {
        const name = interfaceName(id);
        if ((await livePid(id)) === undefined) {
            if (await toolMissing("openconnect")) {
                return { state: "unavailable" };
            }
            // A log with content but no live client is a dial that failed or a tunnel that died, surfacing the
            // reason beats a bare "disconnected" the user can't act on.
            const log = await logTail(logPath(id), 4);
            const hint = dialFailureHint(log);
            return hint === undefined ? { state: "disconnected" } : { state: "failed", detail: hint };
        }
        const address = await interfaceAddress(name);
        if (address === undefined) {
            // The client is alive but the gateway hasn't finished configuring the interface, the dial window.
            return { state: "connecting", interface: name };
        }
        return { state: "connected", interface: name, address, routes: await interfaceRoutes(name), dns: await activeResolvers() };
    },
};
