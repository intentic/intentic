import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
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
// FortiClient's DH group numbers to strongSwan's names.
const DH_GROUPS: Record<IpsecVpnConfig["dhGroup"], string> = {
    "2": "modp1024",
    "5": "modp1536",
    "14": "modp2048",
    "15": "modp3072",
    "16": "modp4096",
    "19": "ecp256",
    "20": "ecp384",
};

// ONE DH group across both phases, and it is load-bearing. IKEv1 quick mode carries a single KE payload, and
// strongSwan derives its group from the IKE SA — so a phase-1 list whose FIRST entry is a different group than
// the gateway wants for phase 2 gets NO_PROPOSAL_CHOSEN whatever the esp= line says. Verified end to end: with
// phase 1 on modp1536 the gateway received ESP proposals carrying MODP_1536 and refused; pinning both phases
// to the configured group established the CHILD_SA.
//
// Ciphers stay a short list (the responder picks); only the group is pinned.
// Falls back rather than trusting the lookup: an unmapped group would splice the literal "undefined" into a
// proposal string and produce an ipsec.conf charon rejects wholesale.
const dhOf = (raw: IpsecVpnConfig): string => DH_GROUPS[raw.dhGroup] ?? DH_GROUPS["14"];

const ikeProposals = (raw: IpsecVpnConfig): string => {
    const dh = dhOf(raw);
    return `aes128-sha256-${dh},aes256-sha256-${dh},aes128-sha1-${dh},aes256-sha1-${dh}`;
};
// PFS off means NO group at all: one DH-bearing proposal is enough to make strongSwan send a KE payload, which
// a gateway configured without PFS rejects outright.
const espProposals = (raw: IpsecVpnConfig): string => {
    if (raw.pfs === "off") {
        return "aes128-sha256,aes256-sha256,aes128-sha1,aes256-sha1";
    }
    const dh = dhOf(raw);
    return `aes128-sha256-${dh},aes256-sha256-${dh},aes128-sha1-${dh},aes256-sha1-${dh}`;
};

// The remote traffic selector: which networks this client asks the gateway to route into the tunnel. Whitespace
// is normalised out because a user types "10.0.0.0/8, 192.168.0.0/16" and strongSwan reads this file literally.
// Falls back rather than trusting the value, for the same reason dhOf does: an empty rightsubnet makes charon
// reject the include file WHOLESALE, which takes every other tunnel on this sandbox down with it.
const routedNetworks = (raw: IpsecVpnConfig): string => {
    const networks = raw.routedNetworks
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
    return networks.length === 0 ? "0.0.0.0/0" : networks.join(",");
};

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
        `    ike=${ikeProposals(raw)}`,
        `    esp=${espProposals(raw)}`,
        `    right=${raw.server}`,
        `    rightid=${raw.remoteId ?? "%any"}`,
        // What the gateway is asked to route into the tunnel. NOT a fixed 0.0.0.0/0 any more: a dial-up gateway
        // does not necessarily narrow what it is offered — a FortiGate happily accepts the catch-all, and then
        // drops everything it has no route for, so a sandbox that asked for everything loses the internet
        // (its own connection to the model included) the moment the tunnel comes up.
        `    rightsubnet=${routedNetworks(raw)}`,
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
    const xauth =
        raw.username !== undefined && raw.password !== undefined
            ? `${JSON.stringify(raw.username)} : XAUTH ${JSON.stringify(raw.password)}`
            : undefined;
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

// Whether charon has LOADED a connection — distinct from it being up. In `ipsec statusall` a loaded connection
// appears under "Connections:" as `<name>:` with no bracket, while its live SAs use `<name>[n]:` / `<name>{n}:`.
export const parseIpsecLoaded = (conn: string, output: string): boolean =>
    output.split("\n").some((line) => new RegExp(`^\\s*${conn}:\\s`).test(line));

// `ipsec start` forks and returns immediately, and `ipsec reload` only ASKS starter to re-read ipsec.conf —
// neither waits for the connection to reach charon. Dialling in that window fails with charon's least helpful
// message, "no config named '<conn>'", which reads like the config was never written when in fact it was
// written microseconds earlier. So wait for the connection to actually appear before `ipsec up`.
const CONN_LOAD_TIMEOUT_MS = 20_000;
const waitForConn = async (conn: string): Promise<boolean> => {
    for (let attempt = 0; attempt * 500 < CONN_LOAD_TIMEOUT_MS; attempt++) {
        const { stdout } = await exec("ipsec", ["statusall", conn]).catch(() => ({ stdout: "" }));
        if (parseIpsecLoaded(conn, stdout)) {
            return true;
        }
        await delay(500);
    }
    return false;
};

// One connection's line pair from `ipsec statusall`. The IKE_SA line carries ESTABLISHED; the CHILD_SA line
// carries "<localTS> === <remoteTS>", where the local traffic selector IS the virtual IP the gateway assigned
// and the remote one is what it routed into the tunnel. Parsed as a pure function against real output shape.
export interface IpsecStatus {
    // A CHILD_SA is INSTALLED — the ONLY state in which traffic actually flows. Reported as "connected".
    readonly established: boolean;
    // Phase 1 is up but no CHILD_SA yet. Reporting this as connected was a false positive: XAuth and the
    // virtual IP can all succeed and quick mode still fail (NO_PROPOSAL_CHOSEN on a PFS mismatch), leaving a
    // tunnel that looks up and routes nothing.
    readonly negotiating: boolean;
    readonly address?: string | undefined;
    readonly routes: string[];
}

export const parseIpsecStatus = (conn: string, output: string): IpsecStatus => {
    // Matched line by line rather than with one multi-line regex: `\s` crosses newlines, so a pattern spanning
    // "selector === selector" would happily start on the CHILD_SA's INSTALLED line and finish on the next one.
    const lines = output.split("\n");
    const ikeUp = lines.some((line) => new RegExp(`^\\s*${conn}\\[\\d+\\]:\\s+ESTABLISHED`).test(line));
    // e.g. "e2e{1}:  INSTALLED, TUNNEL, reqid 1, ESP in UDP SPIs: …"
    const childInstalled = lines.some((line) => new RegExp(`^\\s*${conn}\\{\\d+\\}:\\s+INSTALLED`).test(line));
    // e.g. "systemeg{1}:   10.212.134.200/32 === 0.0.0.0/0" — the left side is the virtual IP the gateway
    // assigned through mode config, the right side is what it routed into the tunnel.
    const childPrefix = new RegExp(`^\\s*${conn}\\{\\d+\\}:`);
    const selectorLine = lines.find((line) => childPrefix.test(line) && line.includes(" === "));
    if (selectorLine === undefined) {
        return { established: childInstalled, negotiating: ikeUp && !childInstalled, routes: [] };
    }
    const [local, remote] = selectorLine.slice(selectorLine.indexOf(":") + 1).split(" === ");
    return {
        established: childInstalled,
        negotiating: ikeUp && !childInstalled,
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

// charon's own log is precise but says nothing about WHICH setting to change. Each pattern below maps a
// negotiation failure onto the field responsible, because the raw line is close to unactionable otherwise —
// "calculated HASH does not match HASH payload" is IKEv1's way of saying the pre-shared key is wrong, and
// nothing in it points at the pre-shared key.
export const ipsecFailureHint = (log: string): string | undefined => {
    if (/calculated HASH does not match/i.test(log)) {
        return "The gateway rejected the pre-shared key. In aggressive mode this is what a wrong PSK looks like — phase 1 gets as far as hashing, then fails. Check the Pre-shared key (and the Local ID, which is what selects the key on a dial-up gateway).";
    }
    if (/XAUTH.*failed|authentication of '.*' with XAuth|xauth.*(rejected|failed)/i.test(log)) {
        return "The pre-shared key was accepted but the XAuth sign-in failed — check the XAuth username and password.";
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
        if (!(await waitForConn(conn))) {
            throw new Error(
                `strongSwan did not load the "${id}" connection within ${CONN_LOAD_TIMEOUT_MS / 1000}s of being asked to. Its config is at ${ipsecConnPath(id)}; \`ipsec statusall\` shows what charon did load.`,
            );
        }
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
            const hint = ipsecFailureHint(dialOutput);
            throw new Error(
                [`strongSwan could not establish ${id}.`, hint, dialOutput].filter((part) => part !== undefined && part !== "").join("\n\n"),
            );
        }
        // Name what was asked for, and say the consequence out loud while a full tunnel is still the default.
        // This is the last message that reaches the user before a gateway without internet egress swallows the
        // sandbox's own outbound traffic — after that there is nothing to read the explanation from.
        const networks = routedNetworks(ipsec);
        yield {
            kind: "log",
            message:
                networks === "0.0.0.0/0"
                    ? `Connected ${id}. ALL traffic now rides the IPsec tunnel. If this sandbox goes quiet from here, the gateway is not routing the internet — set the capability's routed networks to the ones behind it (10.0.0.0/8,192.168.0.0/16) and only those ride the tunnel.`
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
            // Phase 1 up with no CHILD_SA is genuinely mid-negotiation (or a quick-mode failure that DPD will
            // retry) — never "connected", because nothing routes through it.
            return status.negotiating ? { state: "connecting", interface: `ipsec:${conn}` } : { state: "disconnected" };
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
