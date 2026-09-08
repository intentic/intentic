import { execFile, spawn } from "node:child_process";
import { open, mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import type { FortinetVpnConfig, VpnConfig } from "@intentic/sandbox-contract";
import { activeResolvers, interfaceAddress, interfaceRoutes, livePid as livePidOf, logTail, toolMissing } from "../tunnel/net-probe.js";
import type { VpnDialOptions, VpnDriver, VpnProbe } from "./vpn-driver.js";
import { interfaceName, logPath, pidPath, vpnDir } from "./vpn-paths.js";

// FortiGate SSL-VPN (FortiClient's <sslvpn>), dialled with openconnect's fortinet protocol; openconnect uses a tun
// device, not pppd, matching the vpn capability's /dev/net/tun + NET_ADMIN grant.
// openconnect backgrounds itself only after the tunnel is up, so its foreground exit code is the dial's verdict: 0
// connected, anything else means the log holds the reason.

const exec = promisify(execFile);
const config = (raw: VpnConfig): FortinetVpnConfig => raw as FortinetVpnConfig;

// A dial that hasn't resolved by now is wedged (an unreachable gateway, an unanswerable prompt) and is killed rather
// than left open.
const DIAL_TIMEOUT_MS = 90_000;

const fortinetGateway = (raw: FortinetVpnConfig): string => `${raw.server}:${raw.port}`;

// openconnect's argv; the password and OTP ride stdin instead, so this command is safe to log and never shows in `ps`.
const openconnectArgs = (id: string, raw: FortinetVpnConfig): string[] => [
    "--protocol=fortinet",
    "--background",
    `--pid-file=${pidPath(id)}`,
    `--interface=${interfaceName(id)}`,
    `--user=${raw.username}`,
    "--passwd-on-stdin",
    ...(raw.realm === undefined ? [] : [`--usergroup=${raw.realm}`]),
    // Pins the digest from openconnect's own refusal for a self-signed/private-CA gateway; absent means ordinary CA
    // validation.
    ...(raw.trustedCert === undefined ? [] : [`--servercert=${raw.trustedCert}`]),
    fortinetGateway(raw),
];

// Stdin in prompt order: password, then the 2FA code if the gateway asks for one; each needs a trailing newline to read
// as a complete answer.
const dialStdin = (password: string, otp: string | undefined): string => (otp === undefined ? `${password}\n` : `${password}\n${otp}\n`);

// The user-facing line for a failed dial; an untrusted-certificate refusal must show the exact --servercert value to
// pin.
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

// Runs openconnect to completion in the foreground with output to a log file, not a pipe: the backgrounded grandchild
// keeps the log fd open, while this promise only waits on stdin, so the parent's exit is observable.
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
            // stdin is always a stream here (stdio[0] is "pipe" above); the `?.` only satisfies spawn's general type,
            // not a reachable null.
            child.stdin?.end(dialStdin(raw.password, otp));
        });
    } finally {
        await handle.close();
    }
};

// Binds this driver's pidfile path and process name to the shared liveness check.
const livePid = (id: string): Promise<number | undefined> => livePidOf(pidPath(id), "openconnect");

export const fortinetDriver: VpnDriver = {
    gateway: (raw) => fortinetGateway(config(raw)),
    // Nothing to persist: credentials live in the capability manifest and reach openconnect over stdin, never touching
    // disk twice.
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
        // Clears a stale pidfile (from a killed rather than shut-down client) so a failed dial below isn't read as
        // still running.
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
            // SIGTERM is openconnect's clean shutdown: it tears down routes via vpnc-script and removes its pidfile; a
            // hard kill would strand routing.
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
            // A log with content but no live client means a failed dial or a died tunnel; surface the reason instead of
            // a bare "disconnected".
            const log = await logTail(logPath(id), 4);
            const hint = dialFailureHint(log);
            return hint === undefined ? { state: "disconnected" } : { state: "failed", detail: hint };
        }
        const address = await interfaceAddress(name);
        if (address === undefined) {
            // The client is alive but the gateway hasn't finished configuring the interface yet.
            return { state: "connecting", interface: name };
        }
        return { state: "connected", interface: name, address, routes: await interfaceRoutes(name), dns: await activeResolvers() };
    },
};
