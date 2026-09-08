import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { pollUntil } from "@intentic/base/async";
import type { IpsecVpnConfig, VpnConfig } from "@intentic/sandbox-contract";
import { activeResolvers, toolMissing } from "../tunnel/net-probe.js";
import type { VpnDriver, VpnProbe } from "./vpn-driver.js";
import { connName, IPSEC_INCLUDE_DIR, ipsecConnPath, ipsecSecretsPath } from "./vpn-paths.js";

// IKEv1/IKEv2 with a pre-shared key and optional XAuth (FortiClient's <ipsecvpn>), run by strongSwan.
// No per-tunnel interface: strongSwan installs kernel XFRM policies, so state comes from charon's status and the
// address is the mode-config virtual IP.
// Each connection is its own file pair under /etc/ipsec.d/intentic, included by ipsec.conf/ipsec.secrets, so one can be
// rewritten without touching another.

const exec = promisify(execFile);
const config = (raw: VpnConfig): IpsecVpnConfig => raw as IpsecVpnConfig;

// No trailing "!": strongSwan can still fall back to defaults. Maps FortiClient DH numbers to strongSwan names.
const DH_GROUPS: Record<IpsecVpnConfig["dhGroup"], string> = {
    "2": "modp1024",
    "5": "modp1536",
    "14": "modp2048",
    "15": "modp3072",
    "16": "modp4096",
    "19": "ecp256",
    "20": "ecp384",
};

// One DH group across both phases: IKEv1 quick mode derives its group from the IKE SA, so a phase-1/phase-2 mismatch
// fails with NO_PROPOSAL_CHOSEN regardless of esp=. Falls back to 14 rather than splicing an unmapped group into
// `undefined`.
const dhOf = (raw: IpsecVpnConfig): string => DH_GROUPS[raw.dhGroup] ?? DH_GROUPS["14"];

const ikeProposals = (raw: IpsecVpnConfig): string => {
    const dh = dhOf(raw);
    return `aes128-sha256-${dh},aes256-sha256-${dh},aes128-sha1-${dh},aes256-sha1-${dh}`;
};
// PFS off means no DH group at all: one DH-bearing proposal would make strongSwan send a KE payload a non-PFS gateway
// rejects.
const espProposals = (raw: IpsecVpnConfig): string => {
    if (raw.pfs === "off") {
        return "aes128-sha256,aes256-sha256,aes128-sha1,aes256-sha1";
    }
    const dh = dhOf(raw);
    return `aes128-sha256-${dh},aes256-sha256-${dh},aes128-sha1-${dh},aes256-sha1-${dh}`;
};

// Remote traffic selector; whitespace is stripped since strongSwan reads the file literally. Falls back to 0.0.0.0/0
// rather than emit an empty rightsubnet, which charon would reject wholesale.
const routedNetworks = (raw: IpsecVpnConfig): string => {
    const networks = raw.routedNetworks
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
    return networks.length === 0 ? "0.0.0.0/0" : networks.join(",");
};

// strongSwan refuses IKEv1 aggressive mode with a PSK unless this is set (the PSK hash goes out unencrypted); only
// written when an aggressive connection exists.
const AGGRESSIVE_DROPIN_PATH = "/etc/strongswan.d/intentic-aggressive.conf";
const AGGRESSIVE_DROPIN = `# Written by the intentic sandbox daemon: an ipsec VPN capability configured for IKEv1 aggressive mode.
charon {
    i_dont_care_about_security_and_use_aggressive_mode_psk = yes
}
`;

// The conn stanza for one connection; pure, so the generated config is unit-testable.
export const ipsecConnConfig = (id: string, raw: IpsecVpnConfig): string => {
    const xauth = raw.username !== undefined && raw.password !== undefined;
    const lines = [
        `# Written by the intentic sandbox daemon for the "${id}" vpn capability: do not edit by hand.`,
        `conn ${connName(id)}`,
        `    keyexchange=ikev${raw.ikeVersion}`,
        ...(raw.ikeVersion === "1" && raw.aggressive === "on" ? ["    aggressive=yes"] : []),
        `    ike=${ikeProposals(raw)}`,
        `    esp=${espProposals(raw)}`,
        `    right=${raw.server}`,
        `    rightid=${raw.remoteId ?? "%any"}`,
        // Not a fixed 0.0.0.0/0: a FortiGate accepts the catch-all then drops whatever it has no route for, taking the
        // sandbox's own internet down with the tunnel.
        `    rightsubnet=${routedNetworks(raw)}`,
        `    left=%defaultroute`,
        ...(raw.localId === undefined ? [] : [`    leftid=${raw.localId}`]),
        // `%config` takes the virtual IP from the gateway's mode config.
        `    leftsourceip=%config`,
        `    leftauth=psk`,
        `    rightauth=psk`,
        ...(xauth ? [`    leftauth2=xauth`, `    xauth_identity=${raw.username}`] : []),
        // Loaded, not dialled; connecting stays a separate explicit operation.
        `    auto=add`,
        `    dpdaction=restart`,
        `    closeaction=restart`,
        `    keyingtries=1`,
    ];
    return `${lines.join("\n")}\n`;
};

// The ipsec.secrets entries for one connection, kept apart from the conn file so only the credential half needs 0600.
export const ipsecSecretsConfig = (raw: IpsecVpnConfig): string => {
    const psk = `${raw.localId ?? "%any"} ${raw.server} : PSK ${JSON.stringify(raw.presharedKey)}`;
    const xauth =
        raw.username !== undefined && raw.password !== undefined
            ? `${JSON.stringify(raw.username)} : XAUTH ${JSON.stringify(raw.password)}`
            : undefined;
    return `${[psk, xauth].filter((line) => line !== undefined).join("\n")}\n`;
};

// strongSwan has no drop-in directory for connections; these top-level files' include line is what makes per-connection
// files work.
const IPSEC_CONF = `# Written by the intentic sandbox daemon: do not edit by hand.
# One file per vpn capability lives in the included directory.
config setup
    charondebug="ike 1, knl 1, cfg 0"

include ${IPSEC_INCLUDE_DIR}/*.conf
`;
const IPSEC_SECRETS = `# Written by the intentic sandbox daemon: do not edit by hand.
include ${IPSEC_INCLUDE_DIR}/*.secrets
`;

// charon answers `ipsec status` only while it is running; starting it is idempotent.
const ensureCharon = async (): Promise<void> => {
    await exec("ipsec", ["start"]).catch(() => undefined);
};

// Whether charon has loaded a connection, distinct from it being up: loaded appears as `<name>:` with no bracket; live
// SAs use `<name>[n]:` / `<name>{n}:`.
export const parseIpsecLoaded = (conn: string, output: string): boolean =>
    output.split("\n").some((line) => new RegExp(`^\\s*${conn}:\\s`).test(line));

// Neither `ipsec start` nor `ipsec reload` waits for charon to load the connection; dialling in that window fails with
// charon's `no config named` error. Waits for the connection to appear before `ipsec up`.
const CONN_LOAD_TIMEOUT_MS = 20_000;
const waitForConn = (conn: string): Promise<boolean> =>
    pollUntil(
        async () => {
            const { stdout } = await exec("ipsec", ["statusall", conn]).catch(() => ({ stdout: "" }));
            return parseIpsecLoaded(conn, stdout);
        },
        { intervalMs: 500, timeoutMs: CONN_LOAD_TIMEOUT_MS },
    );

// Parsed from one connection's `ipsec statusall` lines: IKE_SA carries ESTABLISHED, CHILD_SA carries `<localTS> ===
// <remoteTS>`, the local selector being the assigned virtual IP.
export interface IpsecStatus {
    // True only once the CHILD_SA is INSTALLED, the only state traffic actually flows.
    readonly established: boolean;
    // Phase 1 up, no CHILD_SA yet; quick mode can still fail after XAuth/the virtual IP succeed, routing nothing.
    readonly negotiating: boolean;
    readonly address?: string | undefined;
    readonly routes: string[];
}

export const parseIpsecStatus = (conn: string, output: string): IpsecStatus => {
    // Matched line by line, not with one multi-line regex: `\s` crosses newlines and could span two SA lines.
    const lines = output.split("\n");
    const ikeUp = lines.some((line) => new RegExp(`^\\s*${conn}\\[\\d+\\]:\\s+ESTABLISHED`).test(line));
    // e.g. "e2e{1}:  INSTALLED, TUNNEL, reqid 1, ESP in UDP SPIs: …"
    const childInstalled = lines.some((line) => new RegExp(`^\\s*${conn}\\{\\d+\\}:\\s+INSTALLED`).test(line));
    // Left of `===` is the virtual IP from mode config; right is what the gateway routed into the tunnel.
    const childPrefix = new RegExp(`^\\s*${conn}\\{\\d+\\}:`);
    const selectorLine = lines.find((line) => childPrefix.test(line) && line.includes(" === "));
    if (selectorLine === undefined) {
        return { established: childInstalled, negotiating: ikeUp && !childInstalled, routes: [] };
    }
    const [local, remote] = selectorLine.slice(selectorLine.indexOf(":") + 1).split(" === ");
    return {
        established: childInstalled,
        negotiating: ikeUp && !childInstalled,
        // The first local selector is the virtual IP; a multi-selector tunnel still has just one assigned address.
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

// Maps a charon negotiation failure onto the setting responsible; charon's log is precise but names no field, e.g. a
// HASH mismatch means the pre-shared key is wrong.
export const ipsecFailureHint = (log: string): string | undefined => {
    if (/calculated HASH does not match/i.test(log)) {
        return "The gateway rejected the pre-shared key. In aggressive mode this is what a wrong PSK looks like: phase 1 gets as far as hashing, then fails. Check the Pre-shared key (and the Local ID, which is what selects the key on a dial-up gateway).";
    }
    if (/XAUTH.*failed|authentication of '.*' with XAuth|xauth.*(rejected|failed)/i.test(log)) {
        return "The pre-shared key was accepted but the XAuth sign-in failed: check the XAuth username and password.";
    }
    if (/no shared key found|no private key found/i.test(log)) {
        return "strongSwan found no key for this peer. The Local ID has to match what the gateway expects, since that is what it looks the key up by.";
    }
    if (/NO_PROPOSAL_CHOSEN|no acceptable proposal/i.test(log)) {
        return "The gateway refused every encryption proposal. Check the IKE version and whether aggressive mode matches how the gateway is configured.";
    }
    if (/retransmit|no response|INVALID_KE_PAYLOAD/i.test(log)) {
        return "The gateway did not answer. Check the address, and that UDP 500/4500 out of this sandbox is not blocked.";
    }
    return undefined;
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
        // Holds the PSK and the XAuth password, never group/world readable.
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
    async *connect(id, raw) {
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
        if (!(await waitForConn(conn))) {
            throw new Error(
                `strongSwan did not load the "${id}" connection within ${CONN_LOAD_TIMEOUT_MS / 1000}s of being asked to. Its config is at ${ipsecConnPath(id)}; \`ipsec statusall\` shows what charon did load.`,
            );
        }
        yield { kind: "log", message: `Negotiating IKEv${ipsec.ikeVersion} with ${ipsec.server}…` };
        // `ipsec up` blocks until it resolves; charon's failure reason lands on stdout even when the exit code is zero.
        const dialOutput = await exec("ipsec", ["up", conn]).then(
            (result) => `${result.stdout}${result.stderr}`.trim(),
            (error: unknown) => {
                const failed = error as { stdout?: string; stderr?: string; message?: string };
                return (`${failed.stdout ?? ""}${failed.stderr ?? ""}`.trim() || failed.message) ?? "";
            },
        );
        const after = await exec("ipsec", ["statusall", conn]).catch(() => ({ stdout: "" }));
        if (!parseIpsecStatus(conn, after.stdout).established) {
            const hint = ipsecFailureHint(dialOutput);
            throw new Error(
                [`strongSwan could not establish ${id}.`, hint, dialOutput].filter((part) => part !== undefined && part !== "").join("\n\n"),
            );
        }
        // The last readable message before a gateway with no internet egress can swallow the sandbox's own outbound
        // traffic.
        const networks = routedNetworks(ipsec);
        yield {
            kind: "log",
            message:
                networks === "0.0.0.0/0"
                    ? `Connected ${id}. ALL traffic now rides the IPsec tunnel. If this sandbox goes quiet from here, the gateway is not routing the internet: set the capability's routed networks to the ones behind it (10.0.0.0/8,192.168.0.0/16) and only those ride the tunnel.`
                    : `Connected ${id}. ${networks} now rides the IPsec tunnel; everything else keeps going out directly.`,
        };
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
            // Phase 1 up with no CHILD_SA is mid-negotiation or a quick-mode failure DPD will retry, never connected.
            return status.negotiating ? { state: "connecting", interface: `ipsec:${conn}` } : { state: "disconnected" };
        }
        return {
            state: "connected",
            // No per-tunnel netdev; strongSwan uses kernel XFRM policies, so the connection name stands in for an
            // interface.
            interface: `ipsec:${conn}`,
            address: status.address,
            routes: status.routes,
            dns: await activeResolvers(),
        };
    },
};
