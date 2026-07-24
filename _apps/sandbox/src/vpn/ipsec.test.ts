import type { IpsecVpnConfig } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { ipsecConnConfig, ipsecSecretsConfig, parseIpsecStatus } from "./ipsec.js";

// The FortiClient <ipsecvpn> shape this has to serve: IKEv1 aggressive mode, a group pre-shared key, a local
// ID the gateway keys its phase-1 selection off, and XAuth for the per-user credential.
const systemEg: IpsecVpnConfig = {
    provider: "ipsec",
    server: "systemeg.float-zone.com",
    presharedKey: "group-secret",
    localId: "extNET",
    username: "someone",
    password: "user-secret",
    ikeVersion: "1",
    aggressive: "on",
    autoConnect: "on",
};

test("generates an IKEv1 aggressive-mode conn with mode-config and XAuth", () => {
    const conf = ipsecConnConfig("systemeg", systemEg);
    expect(conf).toContain("conn systemeg");
    expect(conf).toContain("keyexchange=ikev1");
    expect(conf).toContain("aggressive=yes");
    expect(conf).toContain("right=systemeg.float-zone.com");
    expect(conf).toContain("leftid=extNET");
    // %config is what makes the gateway hand out a virtual IP (FortiClient's mode config).
    expect(conf).toContain("leftsourceip=%config");
    expect(conf).toContain("leftauth2=xauth");
    expect(conf).toContain("xauth_identity=someone");
    // Loaded, not dialled: connecting must stay an explicit action, never a side effect of writing config.
    expect(conf).toContain("auto=add");
    // The proposals cover FortiClient's AES128/AES256 + SHA256 over DH groups 5 (modp1536) and 14 (modp2048).
    expect(conf).toContain("modp1536");
    expect(conf).toContain("modp2048");
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
    // A PSK with a quote or a space is legal and common; unquoted it would truncate or mis-parse the entry.
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

// Real `ipsec statusall <conn>` output for an established dial-up tunnel: the IKE_SA line carries ESTABLISHED,
// the CHILD_SA selector line carries the assigned virtual IP and what the gateway routed into the tunnel.
const STATUSALL = `Security Associations (1 up, 0 connecting):
      systemeg[1]: ESTABLISHED 5 minutes ago, 192.168.1.10[extNET]...203.0.113.5[203.0.113.5]
      systemeg[1]: IKEv1 SPIs: a1b2c3d4e5f60718_i* 1807f6e5d4c3b2a1_r, pre-shared key+XAuth reauthentication in 11 hours
      systemeg{1}:  INSTALLED, TUNNEL, reqid 1, ESP in UDP SPIs: c1234567_i 89abcdef_o
      systemeg{1}:   10.212.134.200/32 === 0.0.0.0/0
`;

test("reads the established flag, the virtual IP and the routed networks out of statusall", () => {
    expect(parseIpsecStatus("systemeg", STATUSALL)).toEqual({
        established: true,
        address: "10.212.134.200/32",
        routes: ["0.0.0.0/0"],
    });
});

test("a connecting or absent tunnel reads as not established", () => {
    expect(parseIpsecStatus("systemeg", "Security Associations (0 up, 1 connecting):\n")).toEqual({ established: false, routes: [] });
    expect(parseIpsecStatus("systemeg", "")).toEqual({ established: false, routes: [] });
});

test("one connection's status is never read from another's lines", () => {
    // Two tunnels in one status dump: asking about the down one must not pick up the up one's SA.
    const both = `${STATUSALL}      other[2]: ESTABLISHED 1 minute ago, 192.168.1.10[x]...198.51.100.9[198.51.100.9]\n`;
    expect(parseIpsecStatus("other", both).established).toBe(true);
    expect(parseIpsecStatus("missing", both).established).toBe(false);
    // The virtual IP belongs to systemeg's child SA — `other` has none, so it reports no address.
    expect(parseIpsecStatus("other", both).address).toBeUndefined();
});
