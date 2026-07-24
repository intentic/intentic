import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { IpsecVpnConfig, VpnConfig } from "@intentic/sandbox-contract";
import { activeResolvers, toolMissing } from "./net-probe.js";
import type { VpnDriver, VpnProbe } from "./vpn-driver.js";
import { connName, IPSEC_INCLUDE_DIR, ipsecConnPath, ipsecSecretsPath } from "./vpn-paths.js";

// IKEv1/IKEv2 with a pre-shared key and optional XAuth — what FortiClient's <ipsecvpn> connections speak —
// run by strongSwan. Unlike the other two providers there is no per-tunnel interface: strongSwan installs
// kernel XFRM policies, so "connected" is read from charon's own status and the tunnel's address is the
// virtual IP the gateway handed out through mode config.
//
// Each connection is written as its own pair of files under /etc/ipsec.d/intentic, which /etc/ipsec.conf and
// /etc/ipsec.secrets `include` — so one connection can be written, reread and torn down without regenerating
// anyone else's.

const exec = promisify(execFile);
const config = (raw: VpnConfig): IpsecVpnConfig => raw as IpsecVpnConfig;

// FortiGate dial-up defaults, covering the proposals FortiClient offers (AES128/AES256 with SHA256, DH groups
// 5 and 14). Not terminated with "!" so strongSwan will still negotiate its own defaults if a gateway wants
// something adjacent — a stricter list is the kind of thing that turns a working VPN into an opaque failure.
const IKE_PROPOSALS = "aes128-sha256-modp1536,aes256-sha256-modp2048,aes128-sha256-modp2048,aes256-sha256-modp1536,aes128-sha256-modp1024";
const ESP_PROPOSALS = "aes128-sha256-modp2048,aes256-sha256-modp2048,aes128-sha256,aes256-sha256";

// strongSwan refuses IKEv1 aggressive mode with a PSK unless this is set, and it is right to: the PSK hash goes
// out unencrypted. FortiGate dial-up with a group PSK requires it anyway, so the grant is per sandbox and only
// ever written when an aggressive connection actually exists.
export const AGGRESSIVE_DROPIN_PATH = "/etc/strongswan.d/intentic-aggressive.conf";
export const AGGRESSIVE_DROPIN = `# Written by the intentic sandbox daemon: an ipsec VPN capability configured for IKEv1 aggressive mode.
charon {
    i_dont_care_about_security_and_use_aggressive_mode_psk = yes
}
`;

// The conn stanza for one connection. Pure so the generated config is unit-testable — the whole point of
// keeping strongSwan's file format in one function.
export const ipsecConnConfig = (id: string, raw: IpsecVpnConfig): string => {
    const xauth = raw.username !== undefined && raw.password !== undefined;
    const lines = [
        `# Written by the intentic sandbox daemon for the "${id}" vpn capability — do not edit by hand.`,
        `conn ${connName(id)}`,
        `    keyexchange=ikev${raw.ikeVersion}`,
        ...(raw.ikeVersion === "1" && raw.aggressive === "on" ? ["    aggressive=yes"] : []),
        `    ike=${IKE_PROPOSALS}`,
        `    esp=${ESP_PROPOSALS}`,
        `    right=${raw.server}`,
        `    rightid=${raw.remoteId ?? "%any"}`,
        // A dial-up client asks for everything and lets the gateway narrow it — matching FortiClient's
        // 0.0.0.0/0 remote network.
        `    rightsubnet=0.0.0.0/0`,
        `    left=%defaultroute`,
        ...(raw.localId === undefined ? [] : [`    leftid=${raw.localId}`]),
        // %config = take the virtual IP from the gateway's mode config, which is how FortiGate assigns one.
        `    leftsourceip=%config`,
        `    leftauth=psk`,
        `    rightauth=psk`,
        ...(xauth ? [`    leftauth2=xauth`, `    xauth_identity=${raw.username}`] : []),
        // Loaded but not dialled: connecting is an explicit operation, never a side effect of writing config.
        `    auto=add`,
        `    dpdaction=restart`,
        `    closeaction=restart`,
        `    keyingtries=1`,
    ];
    return `${lines.join("\n")}\n`;
};

// The ipsec.secrets entries for one connection. Kept apart from the conn file so the credential half is the
// only 0600 file and the config half stays readable for diagnosis.
export const ipsecSecretsConfig = (raw: IpsecVpnConfig): string => {
    const psk = `${raw.localId ?? "%any"} ${raw.server} : PSK ${JSON.stringify(raw.presharedKey)}`;
    const xauth = raw.username !== undefined && raw.password !== undefined ? `${JSON.stringify(raw.username)} : XAUTH ${JSON.stringify(raw.password)}` : undefined;
    return `${[psk, xauth].filter((line) => line !== undefined).join("\n")}\n`;
};

// The daemon owns both top-level files: strongSwan has no drop-in directory of its own for connections, so the
// include line is what makes per-connection files work at all.
export const IPSEC_CONF = `# Written by the intentic sandbox daemon — do not edit by hand.
# One file per vpn capability lives in the included directory.
config setup
    charondebug="ike 1, knl 1, cfg 0"

include ${IPSEC_INCLUDE_DIR}/*.conf
`;
export const IPSEC_SECRETS = `# Written by the intentic sandbox daemon — do not edit by hand.
include ${IPSEC_INCLUDE_DIR}/*.secrets
`;

// charon answers `ipsec status` only while it is running; starting it is idempotent.
const ensureCharon = async (): Promise<void> => {
    await exec("ipsec", ["start"]).catch(() => undefined);
};

// One connection's line pair from `ipsec statusall`. The IKE_SA line carries ESTABLISHED; the CHILD_SA line
// carries "<localTS> === <remoteTS>", where the local traffic selector IS the virtual IP the gateway assigned
// and the remote one is what it routed into the tunnel. Parsed as a pure function against real output shape.
export const parseIpsecStatus = (conn: string, output: string): { established: boolean; address?: string | undefined; routes: string[] } => {
    // Matched line by line rather than with one multi-line regex: `\s` crosses newlines, so a pattern spanning
    // "selector === selector" would happily start on the CHILD_SA's INSTALLED line and finish on the next one.
    const lines = output.split("\n");
    const established = lines.some((line) => new RegExp(`^\\s*${conn}\\[\\d+\\]:\\s+ESTABLISHED`).test(line));
    // e.g. "systemeg{1}:   10.212.134.200/32 === 0.0.0.0/0" — the left side is the virtual IP the gateway
    // assigned through mode config, the right side is what it routed into the tunnel.
    const childPrefix = new RegExp(`^\\s*${conn}\\{\\d+\\}:`);
    const selectorLine = lines.find((line) => childPrefix.test(line) && line.includes(" === "));
    if (selectorLine === undefined) {
        return { established, routes: [] };
    }
    const [local, remote] = selectorLine.slice(selectorLine.indexOf(":") + 1).split(" === ");
    return {
        established,
        // The first local traffic selector is the virtual IP; a tunnel with several selectors still has one
        // assigned address, so the rest are routing detail rather than a second identity.
        address: (local ?? "")
            .trim()
            .split(/\s+/)
            .find((entry) => entry !== ""),
        routes: (remote ?? "")
            .trim()
            .split(/\s+/)
            .filter((entry) => entry !== ""),
    };
};

export const ipsecDriver: VpnDriver = {
    gateway: (raw) => config(raw).server,
    write: async (id, raw) => {
        const ipsec = config(raw);
        await mkdir(IPSEC_INCLUDE_DIR, { recursive: true, mode: 0o700 });
        await writeFile("/etc/ipsec.conf", IPSEC_CONF, { mode: 0o644 });
        await writeFile("/etc/ipsec.secrets", IPSEC_SECRETS, { mode: 0o600 });
        if (ipsec.ikeVersion === "1" && ipsec.aggressive === "on") {
            await mkdir("/etc/strongswan.d", { recursive: true }).catch(() => undefined);
            await writeFile(AGGRESSIVE_DROPIN_PATH, AGGRESSIVE_DROPIN, { mode: 0o644 });
        }
        await writeFile(ipsecConnPath(id), ipsecConnConfig(id, ipsec), { mode: 0o644 });
        // Holds the PSK and the XAuth password — never group/world readable.
        await writeFile(ipsecSecretsPath(id), ipsecSecretsConfig(ipsec), { mode: 0o600 });
    },
    erase: async (id) => {
        await rm(ipsecConnPath(id), { force: true });
        await rm(ipsecSecretsPath(id), { force: true });
        // Drop the removed connection from charon's view; harmless when charon isn't running.
        await exec("ipsec", ["rereadall"]).catch(() => undefined);
        await exec("ipsec", ["reload"]).catch(() => undefined);
    },
    missingTool: async () => ((await toolMissing("ipsec", ["--version"])) ? "strongswan (ipsec)" : undefined),
    connect: async function* (id, raw) {
        const ipsec = config(raw);
        const conn = connName(id);
        const status = await exec("ipsec", ["statusall", conn]).catch(() => ({ stdout: "" }));
        if (parseIpsecStatus(conn, status.stdout).established) {
            yield { kind: "log", message: `${id} is already connected to ${ipsec.server}.` };
            return;
        }
        // Re-write before dialling so a credential edited through /secrets takes effect on this connect.
        await ipsecDriver.write(id, raw);
        await ensureCharon();
        // Pick up the files just written; charon caches both config and secrets.
        await exec("ipsec", ["rereadall"]).catch(() => undefined);
        await exec("ipsec", ["reload"]).catch(() => undefined);
        yield { kind: "log", message: `Negotiating IKEv${ipsec.ikeVersion} with ${ipsec.server}…` };
        // `ipsec up` blocks until the negotiation resolves and exits non-zero on failure, printing charon's own
        // reason (NO_PROPOSAL_CHOSEN, AUTHENTICATION_FAILED, …) — the message worth propagating either way,
        // since charon reports the failure on stdout even when the exit code is zero.
        const dialOutput = await exec("ipsec", ["up", conn]).then(
            (result) => `${result.stdout}${result.stderr}`.trim(),
            (error: unknown) => {
                const failed = error as { stdout?: string; stderr?: string; message?: string };
                return (`${failed.stdout ?? ""}${failed.stderr ?? ""}`.trim() || failed.message) ?? "";
            },
        );
        const after = await exec("ipsec", ["statusall", conn]).catch(() => ({ stdout: "" }));
        if (!parseIpsecStatus(conn, after.stdout).established) {
            throw new Error([`strongSwan could not establish ${id}.`, dialOutput].filter((part) => part !== "").join("\n"));
        }
        yield { kind: "log", message: `Connected ${id}. The gateway's routed networks now ride the IPsec tunnel.` };
    },
    disconnect: async (id) => {
        await exec("ipsec", ["down", connName(id)]).catch(() => undefined);
    },
    probe: async (id): Promise<VpnProbe> => {
        if (await toolMissing("ipsec", ["--version"])) {
            return { state: "unavailable" };
        }
        const conn = connName(id);
        const { stdout } = await exec("ipsec", ["statusall", conn]).catch(() => ({ stdout: "" }));
        const status = parseIpsecStatus(conn, stdout);
        if (!status.established) {
            return { state: "disconnected" };
        }
        return {
            state: "connected",
            // No per-tunnel netdev exists: strongSwan routes through kernel XFRM policies, so the connection
            // name is the honest identifier to show where the other drivers show an interface.
            interface: `ipsec:${conn}`,
            address: status.address,
            routes: status.routes,
            dns: await activeResolvers(),
        };
    },
};
