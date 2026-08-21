import { expect, test } from "vitest";
import { parseForticlientConfig, slugId, splitServer } from "./forticlient-config.js";

// An export trimmed to the elements the parser reads, with the shapes a real FortiClient 7.4 file produces:
// EncX-wrapped usernames and pre-shared key, a self-closing empty <username/>, a CDATA description, an
// accented connection name, and an IPsec connection whose endpoint lives in <ike_settings>.
const XML = `<?xml version="1.0" encoding="UTF-8" ?>
<forticlient_configuration generatedby="FCT-7.4.3.4726">
    <vpn>
        <sslvpn>
            <connections>
                <connection>
                    <name>safety-hab</name>
                    <description><![CDATA[serwer ubuntu-vm]]></description>
                    <server>91.234.246.82:10444</server>
                    <username>EncX FE7B405B4349479FD5BB0B8780B0C85B37141BC9E3E2FED3F15928C706CAD3C58</username>
                </connection>
                <connection>
                    <name>ZTM Warszawa</name>
                    <description />
                    <server>theta.ztm.waw.pl:10443</server>
                    <username />
                </connection>
                <connection>
                    <name>Łódź</name>
                    <server>89.171.20.82:31443</server>
                    <username>plain.user</username>
                </connection>
            </connections>
        </sslvpn>
        <ipsecvpn>
            <connections>
                <connection>
                    <name>SystemEG</name>
                    <ike_settings>
                        <version>1</version>
                        <server>systemeg.float-zone.com</server>
                        <authentication_method>Preshared Key</authentication_method>
                        <auth_data><preshared_key>EncX 54BC0C4D3D08B6AECEBD3BC38CC9FA4BE6C6B947</preshared_key></auth_data>
                        <mode>aggressive</mode>
                        <localid>extNET</localid>
                        <peerid />
                        <xauth>
                            <enabled>1</enabled>
                            <username>EncX 308A395F506B449823DAB1F1F099B1F902825FF41BFB9BEB</username>
                            <password />
                        </xauth>
                    </ike_settings>
                    <ipsec_settings>
                        <remote_networks><network><addr>0.0.0.0</addr></network></remote_networks>
                        <dhgroup>14</dhgroup>
                        <key_life_type>seconds</key_life_type>
                        <pfs>1</pfs>
                    </ipsec_settings>
                </connection>
            </connections>
        </ipsecvpn>
    </vpn>
</forticlient_configuration>`;

test("reads every SSL-VPN connection with its endpoint split into host and port", () => {
    const connections = parseForticlientConfig(XML);
    const ssl = connections.filter((connection) => connection.provider === "fortinet");
    expect(ssl.map((connection) => [connection.id, connection.server, connection.port])).toEqual([
        ["safety-hab", "91.234.246.82", 10444],
        ["ztm-warszawa", "theta.ztm.waw.pl", 10443],
        ["lodz", "89.171.20.82", 31443],
    ]);
    // The original name survives for recognition even where the id had to be slugged.
    expect(ssl.map((connection) => connection.label)).toEqual(["safety-hab", "ZTM Warszawa", "Łódź"]);
    expect(ssl[0]?.description).toBe("serwer ubuntu-vm");
});

test("drops FortiClient-encrypted usernames and asks for them, but keeps a plaintext one", () => {
    const ssl = parseForticlientConfig(XML).filter((connection) => connection.provider === "fortinet");
    // EncX is not reversible: reporting it as a needed field beats importing an unusable value.
    expect(ssl[0]?.username).toBeUndefined();
    expect(ssl[0]?.needs).toEqual(["username", "password"]);
    // An empty <username /> is equally "not supplied".
    expect(ssl[1]?.username).toBeUndefined();
    // Stored in the clear ⇒ imported, and only the password is left to type.
    expect(ssl[2]?.username).toBe("plain.user");
    expect(ssl[2]?.needs).toEqual(["password"]);
});

test("reads the IPsec connection's phase-1 endpoint, local id and aggressive mode", () => {
    const ipsec = parseForticlientConfig(XML).find((connection) => connection.provider === "ipsec");
    expect(ipsec).toMatchObject({
        id: "systemeg",
        label: "SystemEG",
        server: "systemeg.float-zone.com",
        // No port on the IKE endpoint ⇒ the IKE default, not the SSL-VPN one.
        port: 500,
        localId: "extNET",
        aggressive: true,
        // Phase 2, from <ipsec_settings>: the pair that decides whether quick mode can succeed at all. The
        // group must NOT come from <ike_settings>, which lists "5;14;" and says nothing about phase 2.
        pfs: true,
        dhGroup: "14",
    });
    // The PSK is always encrypted in an export; XAuth is enabled with an encrypted username, so both it and
    // the password have to be typed.
    expect(ipsec?.needs).toEqual(["presharedKey", "username", "password"]);
    expect(ipsec?.username).toBeUndefined();
});

test("keeps SSL and IPsec connections from being read as each other", () => {
    const connections = parseForticlientConfig(XML);
    expect(connections.filter((connection) => connection.provider === "fortinet")).toHaveLength(3);
    expect(connections.filter((connection) => connection.provider === "ipsec")).toHaveLength(1);
});

test("a file with no connections imports as nothing rather than throwing", () => {
    expect(parseForticlientConfig("<forticlient_configuration><system /></forticlient_configuration>")).toEqual([]);
    expect(parseForticlientConfig("not xml at all")).toEqual([]);
});

test("slugId produces legal capability ids and falls back positionally", () => {
    expect(slugId("ZTM Warszawa", 0)).toBe("ztm-warszawa");
    expect(slugId("Łódź", 0)).toBe("lodz");
    expect(slugId("  ", 4)).toBe("vpn-5");
    expect(slugId("--weird--", 0)).toBe("weird");
});

test("splitServer only treats a trailing :digits as a port", () => {
    expect(splitServer("host.example.com:10443", 443)).toEqual({ host: "host.example.com", port: 10443 });
    expect(splitServer("host.example.com", 443)).toEqual({ host: "host.example.com", port: 443 });
    // An IPv6 literal keeps its colons; nothing trailing looks like a port.
    expect(splitServer("[2001:db8::1]", 500)).toEqual({ host: "[2001:db8::1]", port: 500 });
});

test("reads phase-2 PFS and DH group from <ipsec_settings>, never from <ike_settings>", () => {
    // <ike_settings> offers several groups; only <ipsec_settings> says which one quick mode must use.
    const xml = `<forticlient_configuration><vpn><ipsecvpn><connections><connection>
        <name>gw</name>
        <ike_settings><server>gw.example.com</server><mode>aggressive</mode><dhgroup>5;14;</dhgroup></ike_settings>
        <ipsec_settings><dhgroup>14</dhgroup><pfs>1</pfs></ipsec_settings>
    </connection></connections></ipsecvpn></vpn></forticlient_configuration>`;
    expect(parseForticlientConfig(xml)[0]).toMatchObject({ dhGroup: "14", pfs: true });
});

test("an explicit <pfs>0</pfs> turns PFS off; a missing one leaves it on", () => {
    const build = (phase2: string): string =>
        `<forticlient_configuration><vpn><ipsecvpn><connections><connection><name>gw</name>
         <ike_settings><server>gw.example.com</server></ike_settings>
         <ipsec_settings>${phase2}</ipsec_settings></connection></connections></ipsecvpn></vpn></forticlient_configuration>`;
    expect(parseForticlientConfig(build("<pfs>0</pfs>"))[0]?.pfs).toBe(false);
    // FortiClient omits <pfs> when it is on, so absence must not read as off.
    expect(parseForticlientConfig(build(""))[0]?.pfs).toBe(true);
});

test("a DH group the capability cannot express is dropped rather than imported wrong", () => {
    const xml = `<forticlient_configuration><vpn><ipsecvpn><connections><connection><name>gw</name>
        <ike_settings><server>gw.example.com</server></ike_settings>
        <ipsec_settings><dhgroup>31</dhgroup></ipsec_settings></connection></connections></ipsecvpn></vpn></forticlient_configuration>`;
    expect(parseForticlientConfig(xml)[0]?.dhGroup).toBeUndefined();
});
