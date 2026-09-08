import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { toolMissing } from "./net-probe.js";

// wg-quick, shared by both tunnel kinds. A dial is synchronous, so no client process to supervise: the interface is the
// tunnel, `wg show` answers liveness, and the conf is dialled by PATH, never written to /etc/wireguard.

const exec = promisify(execFile);

// `wg show <if>` succeeds only for an existing WireGuard interface.
export const wireguardUp = async (name: string): Promise<boolean> =>
    exec("wg", ["show", name]).then(
        () => true,
        () => false,
    );

// wg-quick must exist to dial; it arrives with the capability's image fragment, and until then a link reads
// "unavailable" rather than failing.
export const wireguardMissing = async (): Promise<string | undefined> => ((await toolMissing("wg-quick", ["--help"])) ? "wg-quick" : undefined);

// [Peer] Endpoint for display; parsed leniently since a conf with no endpoint (dial-in only peer) is legal.
export const wireguardEndpoint = (conf: string): string | undefined => /^\s*Endpoint\s*=\s*(\S+)/im.exec(conf)?.[1];

// Conf holds the interface's private key: written 0600 in a 0700 dir, and only its path ever reaches a command line,
// never the key itself.
export const writeWireguardConf = async (path: string, conf: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, conf.endsWith("\n") ? conf : `${conf}\n`, { mode: 0o600 });
};

export const wireguardDial = async (confPath: string): Promise<void> => {
    await exec("wg-quick", ["up", confPath]);
};

// Already down, no conf, no wg-quick: all reduce to "not up", the goal state.
export const wireguardDrop = async (confPath: string): Promise<void> => {
    await exec("wg-quick", ["down", confPath]).catch(() => undefined);
};
