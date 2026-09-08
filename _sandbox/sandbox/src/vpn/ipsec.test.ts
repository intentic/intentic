import type { IpsecVpnConfig } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { ipsecConnConfig, ipsecFailureHint, ipsecSecretsConfig, parseIpsecLoaded, parseIpsecStatus } from "./ipsec.js";

// FortiClient <ipsecvpn> shape: IKEv1 aggressive, a group PSK, a phase-1 local ID, and per-user XAuth.
const systemEg: IpsecVpnConfig = {
    provider: "ipsec",
    server: "systemeg.float-zone.com",
    presharedKey: "group-secret",
    localId: "extNET",
    username: "someone",
    password: "user-secret",
    ikeVersion: "1",
    aggressive: "on",
    pfs: "on",
    dhGroup: "14",
    routedNetworks: "0.0.0.0/0",
    autoConnect: "on",
};

test("generates an IKEv1 aggressive-mode conn with mode-config and XAuth", () => {
    const conf = ipsecConnConfig("systemeg", systemEg);
    expect(conf).toContain("conn systemeg");
    expect(conf).toContain("keyexchange=ikev1");
    expect(conf).toContain("aggressive=yes");
    expect(conf).toContain("right=systemeg.float-zone.com");
    expect(conf).toContain("leftid=extNET");
    // `%config` is what makes the gateway hand out a virtual IP.
    expect(conf).toContain("leftsourceip=%config");
    expect(conf).toContain("leftauth2=xauth");
    expect(conf).toContain("xauth_identity=someone");
    // `auto=add` loads the config without dialling; connecting stays a separate explicit action.
    expect(conf).toContain("auto=add");
    // One DH group across both phases: IKEv1 quick mode derives its KE group from the IKE SA; a mismatch is refused
    // with NO_PROPOSAL_CHOSEN.
    expect(conf).toContain("ike=aes128-sha256-modp2048");
    expect(conf).toContain("esp=aes128-sha256-modp2048");
    expect(conf).not.toContain("modp1536");
});

test("the routed networks are what the tunnel asks the gateway to route, not a fixed catch-all", () => {
    expect(ipsecConnConfig("x", systemEg)).toContain("rightsubnet=0.0.0.0/0");
    const split = ipsecConnConfig("x", { ...systemEg, routedNetworks: "192.168.0.0/16" });
    expect(split).toContain("rightsubnet=192.168.0.0/16");
    expect(split).not.toContain("0.0.0.0/0");
    // Typed with spaces like a person would; strongSwan reads the file literally, so spaces are stripped.
    expect(ipsecConnConfig("x", { ...systemEg, routedNetworks: "10.0.0.0/8, 192.168.0.0/16" })).toContain("rightsubnet=10.0.0.0/8,192.168.0.0/16");
});

test("a blank routed-networks value still produces a loadable file", () => {
    // An empty rightsubnet would make charon reject the whole included config, taking every other tunnel down with it.
    expect(ipsecConnConfig("x", { ...systemEg, routedNetworks: " , " })).toContain("rightsubnet=0.0.0.0/0");
});

test("omits aggressive mode for IKEv2 and for an explicitly disabled IKEv1 tunnel", () => {
    expect(ipsecConnConfig("x", { ...systemEg, ikeVersion: "2" })).not.toContain("aggressive=yes");
    expect(ipsecConnConfig("x", { ...systemEg, aggressive: "off" })).not.toContain("aggressive=yes");
    expect(ipsecConnConfig("x", { ...systemEg, ikeVersion: "2" })).toContain("keyexchange=ikev2");
});

test("omits the XAuth stanza for a PSK-only tunnel", () => {
    const conf = ipsecConnConfig("psk-only", { ...systemEg, username: undefined, password: undefined });
    expect(conf).not.toContain("xauth");
    expect(conf).toContain("leftauth=psk");
});

test("writes both secrets in strongSwan's ipsec.secrets format, quoted", () => {
    const secrets = ipsecSecretsConfig(systemEg);
    expect(secrets).toContain(`extNET systemeg.float-zone.com : PSK "group-secret"`);
    expect(secrets).toContain(`"someone" : XAUTH "user-secret"`);
});

test("quotes a secret containing characters that would otherwise break the file", () => {
    // A PSK with a quote or a space is legal; unquoted it would truncate or mis-parse the entry.
    const secrets = ipsecSecretsConfig({ ...systemEg, presharedKey: 'has "quotes" and spaces' });
    expect(secrets).toContain(String.raw`PSK "has \"quotes\" and spaces"`);
});

test("a PSK-only tunnel writes no XAUTH line", () => {
    const secrets = ipsecSecretsConfig({ ...systemEg, username: undefined, password: undefined });
    expect(secrets).not.toContain("XAUTH");
    expect(secrets).toContain("PSK");
});

test("falls back to %any as the PSK selector when no local id is configured", () => {
    expect(ipsecSecretsConfig({ ...systemEg, localId: undefined })).toContain("%any systemeg.float-zone.com : PSK");
});

// `ipsec statusall` output: IKE_SA carries ESTABLISHED; CHILD_SA carries the virtual IP and routes.
const STATUSALL = `Security Associations (1 up, 0 connecting):
      systemeg[1]: ESTABLISHED 5 minutes ago, 192.168.1.10[extNET]...203.0.113.5[203.0.113.5]
      systemeg[1]: IKEv1 SPIs: a1b2c3d4e5f60718_i* 1807f6e5d4c3b2a1_r, pre-shared key+XAuth reauthentication in 11 hours
      systemeg{1}:  INSTALLED, TUNNEL, reqid 1, ESP in UDP SPIs: c1234567_i 89abcdef_o
      systemeg{1}:   10.212.134.200/32 === 0.0.0.0/0
`;

test("reads the established flag, the virtual IP and the routed networks out of statusall", () => {
    expect(parseIpsecStatus("systemeg", STATUSALL)).toEqual({
        established: true,
        negotiating: false,
        address: "10.212.134.200/32",
        routes: ["0.0.0.0/0"],
    });
});

test("a connecting or absent tunnel reads as not established", () => {
    expect(parseIpsecStatus("systemeg", "Security Associations (0 up, 1 connecting):\n")).toEqual({
        established: false,
        negotiating: false,
        routes: [],
    });
    expect(parseIpsecStatus("systemeg", "")).toEqual({ established: false, negotiating: false, routes: [] });
});

test("one connection's status is never read from another's lines", () => {
    // Two tunnels in one dump: asking about the down one must not pick up the other's SA.
    const both = `${STATUSALL}      other[2]: ESTABLISHED 1 minute ago, 192.168.1.10[x]...198.51.100.9[198.51.100.9]\n`;
    // `other` has an IKE_SA but no CHILD_SA, so it reads as negotiating, not connected, and must not inherit systemeg's
    // child SA.
    expect(parseIpsecStatus("other", both)).toEqual({ established: false, negotiating: true, routes: [] });
    expect(parseIpsecStatus("missing", both)).toEqual({ established: false, negotiating: false, routes: [] });
    expect(parseIpsecStatus("systemeg", both).established).toBe(true);
});

// Charon output: proposal accepted, key rejected; opaque IKE internals unless translated.
const WRONG_PSK = `initiating Aggressive Mode IKE_SA systemeg[1] to 83.14.172.242
selected proposal: IKE:AES_CBC_128/HMAC_SHA2_256_128/PRF_HMAC_SHA2_256/MODP_1536
calculated HASH does not match HASH payload
generating INFORMATIONAL_V1 request 749021581 [ HASH N(AUTH_FAILED) ]
establishing connection 'systemeg' failed`;

test("a hash mismatch is reported as the wrong pre-shared key, not as raw IKE internals", () => {
    const hint = ipsecFailureHint(WRONG_PSK);
    expect(hint).toContain("pre-shared key");
    expect(hint).toContain("Local ID");
});

test("distinguishes the failure modes a user can actually act on", () => {
    expect(ipsecFailureHint("no shared key found for 'extNET'")).toContain("Local ID");
    expect(ipsecFailureHint("received NO_PROPOSAL_CHOSEN error notify")).toContain("aggressive mode");
    expect(ipsecFailureHint("retransmit 5 of request with message ID 0")).toContain("did not answer");
    expect(ipsecFailureHint("XAuth authentication of 'someone' failed")).toContain("XAuth");
    // An unrecognized failure returns undefined rather than inventing an explanation.
    expect(ipsecFailureHint("something entirely new")).toBeUndefined();
});

// A loaded connection is `<name>:` under "Connections:"; live SAs use `<name>[n]:` and `<name>{n}:`.
test("parseIpsecLoaded distinguishes a loaded connection from its SAs and from nothing", () => {
    const loaded = `Connections:
    systemeg:  %any...systemeg.float-zone.com  IKEv1 Aggressive, dpddelay=30s
    systemeg:   local:  [extNET] uses pre-shared key authentication
Security Associations (0 up, 0 connecting):
  none`;
    expect(parseIpsecLoaded("systemeg", loaded)).toBe(true);
    // Charon is up but the connection is not loaded yet.
    expect(parseIpsecLoaded("systemeg", "Connections:\nSecurity Associations (0 up, 0 connecting):\n  none")).toBe(false);
    expect(parseIpsecLoaded("systemeg", "")).toBe(false);
    // An SA line alone must not read as "loaded", nor may another connection's name.
    expect(parseIpsecLoaded("systemeg", "      systemeg[1]: ESTABLISHED 5 minutes ago")).toBe(false);
    expect(parseIpsecLoaded("systemeg", "    other:  %any...vpn.example.com  IKEv1 Aggressive")).toBe(false);
});

// Phase 1 up, quick mode failed; reporting this as connected would claim a tunnel that routes nothing.
const IKE_ONLY = `Security Associations (1 up, 0 connecting):
      e2e[1]: ESTABLISHED 17 seconds ago, 10.77.0.20[extNET]...10.77.0.10[10.77.0.10]
      e2e[1]: IKEv1 SPIs: d57c3af1a0913198_i* 2ff7fc14da47e16d_r, pre-shared key+XAuth reauthentication in 2 hours`;

test("phase 1 without a CHILD_SA is negotiating, never connected", () => {
    const status = parseIpsecStatus("e2e", IKE_ONLY);
    expect(status.established).toBe(false);
    expect(status.negotiating).toBe(true);
});

test("an installed CHILD_SA is what counts as connected", () => {
    const full = `${IKE_ONLY}\n      e2e{1}:  INSTALLED, TUNNEL, reqid 1, ESP in UDP SPIs: c1_i 89_o\n      e2e{1}:   10.88.0.1/32 === 0.0.0.0/0`;
    const status = parseIpsecStatus("e2e", full);
    expect(status.established).toBe(true);
    expect(status.negotiating).toBe(false);
    expect(status.address).toBe("10.88.0.1/32");
    expect(status.routes).toEqual(["0.0.0.0/0"]);
});

test("PFS decides whether quick mode offers a DH group at all", () => {
    // A non-PFS gateway rejects any DH-bearing proposal; only the esp= line matters, since phase 1's ike= line always
    // carries a DH group regardless.
    const espLine = (conf: string): string => conf.split("\n").find((line) => line.trim().startsWith("esp=")) ?? "";
    expect(espLine(ipsecConnConfig("x", { ...systemEg, pfs: "on" }))).toContain("modp2048");
    expect(espLine(ipsecConnConfig("x", { ...systemEg, pfs: "off" }))).not.toContain("modp");
    expect(espLine(ipsecConnConfig("x", { ...systemEg, pfs: "off" }))).toContain("aes128-sha256");
});

test("the DH group is pinned identically in both phases, and never emits an unmapped literal", () => {
    for (const [group, name] of [
        ["5", "modp1536"],
        ["2", "modp1024"],
        ["19", "ecp256"],
    ] as const) {
        const conf = ipsecConnConfig("x", { ...systemEg, dhGroup: group });
        expect(conf).toContain(`ike=aes128-sha256-${name}`);
        expect(conf).toContain(`esp=aes128-sha256-${name}`);
    }
    // An unmapped DH group must still produce a loadable file, not `...-undefined`.
    const broken = ipsecConnConfig("x", { ...systemEg, dhGroup: "99" as unknown as IpsecVpnConfig["dhGroup"] });
    expect(broken).not.toContain("undefined");
    expect(broken).toContain("modp2048");
});
