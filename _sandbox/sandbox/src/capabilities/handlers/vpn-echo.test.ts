import { VpnConfigSchema } from "@intentic/sandbox-contract/schemas/vpn";
import { vpnHandler } from "./vpn.handler.js";

const echo = (config: unknown): Record<string, unknown> => vpnHandler.echo(VpnConfigSchema.parse(config), new Map());

test("an ipsec echo keeps every setting the form edits, its MTU included, and neither credential", () => {
    const echoed = echo({
        provider: "ipsec",
        server: "gw.example.com",
        presharedKey: "group-secret",
        username: "someone",
        password: "user-secret",
        localId: "extNET",
        routedNetworks: "192.168.0.0/16",
        mtu: "1190",
    });
    expect(echoed).toEqual({
        provider: "ipsec",
        autoConnect: "on",
        server: "gw.example.com",
        ikeVersion: "1",
        aggressive: "on",
        pfs: "on",
        dhGroup: "14",
        routedNetworks: "192.168.0.0/16",
        username: "someone",
        localId: "extNET",
        mtu: 1190,
    });
});

test("an unset optional setting is left out rather than echoed as undefined", () => {
    const echoed = echo({ provider: "ipsec", server: "gw.example.com", presharedKey: "group-secret" });
    expect(Object.keys(echoed)).not.toContain("mtu");
    expect(Object.keys(echoed)).not.toContain("username");
});

test("fortinet echoes its endpoint and sign-in name without the password; wireguard only its intent", () => {
    expect(echo({ provider: "fortinet", server: "vpn.example.com", username: "me", password: "pw", realm: "staff" })).toEqual({
        provider: "fortinet",
        autoConnect: "on",
        server: "vpn.example.com",
        port: 443,
        username: "me",
        realm: "staff",
    });
    expect(echo({ provider: "wireguard", config: "[Interface]\nPrivateKey = k" })).toEqual({ provider: "wireguard", autoConnect: "on" });
});
