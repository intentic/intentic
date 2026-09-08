import { expect, test } from "vitest";
import { countryOfConf, neutralisedConf, parseWireguardConfigs } from "./wireguard-exit.js";

// Pins the shapes real providers write into .conf files, and the shapes that must not be read as a country, so a pasted
// file needs no annotation.

const PROTON = `[Interface]
# Key for exit-nl
PrivateKey = AAAA
Address = 10.2.0.2/32
DNS = 10.2.0.1

[Peer]
# NL-FREE#1
PublicKey = BBBB
AllowedIPs = 0.0.0.0/0
Endpoint = 91.207.175.1:51820`;

const MULLVAD = `[Interface]
PrivateKey = CCCC
Address = 10.64.1.2/32
DNS = 10.64.0.1

[Peer]
PublicKey = DDDD
AllowedIPs = 0.0.0.0/0,::0/0
Endpoint = de-ber-wg-001.relays.mullvad.net:51820`;

test("Proton's peer label is read as its country", () => {
    expect(countryOfConf(PROTON)).toBe("NL");
});

test("Mullvad's relay hostname is read as its country", () => {
    expect(countryOfConf(MULLVAD)).toBe("DE");
});

test("an explicit country line beats every other signal", () => {
    expect(countryOfConf(`# country: FR\n${MULLVAD}`)).toBe("FR");
    expect(countryOfConf(`# country = fr\n${MULLVAD}`)).toBe("FR");
});

test("ordinary comments and hostnames are NOT mistaken for countries", () => {
    expect(countryOfConf("[Interface]\n# my-server-1\nPrivateKey = X\nEndpoint = 1.2.3.4:51820")).toBeUndefined();
    expect(countryOfConf("[Interface]\n# in-progress, do not use\nPrivateKey = X\nEndpoint = 1.2.3.4:51820")).toBeUndefined();
    // Two dash-separated parts is a hostname, not a relay name.
    expect(countryOfConf("[Interface]\nPrivateKey = X\n[Peer]\nEndpoint = my-vpn.example.com:51820")).toBeUndefined();
    // `node-nl-01` doesn't start with a country code and must not read as Norway.
    expect(countryOfConf("[Interface]\nPrivateKey = X\n[Peer]\nEndpoint = node-nl-01.protonvpn.net:51820")).not.toBe("NO");
    // A bare IP carries no country; dialling and observing answers that instead.
    expect(countryOfConf("[Interface]\nPrivateKey = X\n[Peer]\nEndpoint = 203.0.113.9:51820")).toBeUndefined();
});

test("configs pasted back to back become one pool", () => {
    const pool = parseWireguardConfigs(`${PROTON}\n\n${MULLVAD}`);
    expect(pool).toHaveLength(2);
    expect(pool.map((profile) => profile.country)).toEqual(["NL", "DE"]);
    expect(pool[1]?.endpoint).toBe("de-ber-wg-001.relays.mullvad.net:51820");
    expect(pool.map((profile) => profile.name)).toEqual(["NL-1", "DE-2"]);
});

test("an unlabelled config still becomes a usable pool entry", () => {
    const pool = parseWireguardConfigs("[Interface]\nPrivateKey = X\n\n[Peer]\nEndpoint = 203.0.113.9:51820");
    expect(pool).toHaveLength(1);
    expect(pool[0]?.country).toBeUndefined();
    expect(pool[0]?.name).toBe("exit-1");
});

test("noise around and between configs is ignored", () => {
    expect(parseWireguardConfigs("")).toEqual([]);
    expect(parseWireguardConfigs("not a config at all")).toEqual([]);
    expect(parseWireguardConfigs(`  \n${PROTON}\n   \n`)).toHaveLength(1);
});

test("a pasted config is neutralised before it is ever brought up", () => {
    const safe = neutralisedConf(PROTON);
    // DNS surviving rewrites the whole container's resolver; a missing Table=off lets the pushed route hijack main.
    expect(safe).not.toMatch(/^\s*DNS\s*=/im);
    expect(safe).toMatch(/^Table = off$/im);
    expect(safe).toContain("PrivateKey = AAAA");
    expect(safe).toContain("Endpoint = 91.207.175.1:51820");
    expect(safe).toContain("AllowedIPs = 0.0.0.0/0");
    // Table = off goes inside [Interface]; anywhere else wg-quick ignores it.
    const lines = safe.split("\n");
    expect(lines[lines.findIndex((line) => /\[Interface\]/.test(line)) + 1]).toBe("Table = off");
});

test("a config that already sets Table is overridden, not doubled", () => {
    const safe = neutralisedConf("[Interface]\nTable = 51820\nPrivateKey = X\n\n[Peer]\nEndpoint = 1.2.3.4:1");
    expect(safe.match(/^Table\s*=/gim)).toHaveLength(1);
    expect(safe).toMatch(/^Table = off$/im);
});
