import { expect, test } from "vitest";
import { parseVpngateCsv } from "./vpngate.js";

// VPN Gate's public CSV IS this provider's catalog: no account, no server names to type, a country picked and
// a server chosen for you. That makes the parser the whole auto-fill story, so it is pinned against the real
// format, banner and terminator included.

const HEADER = "*vpn_servers";
const COLUMNS =
    "#HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,NumVpnSessions,Uptime,TotalUsers,TotalTraffic,LogType,Operator,Message,OpenVPN_ConfigData_Base64";
const row = (host: string, ip: string, score: string, country: string, config = "Y29uZmln"): string =>
    `${host},${ip},${score},20,296187962,Long,${country},72,7589151454,13176646,689673718444238,2weeks,Operator,,${config}`;

const csv = (...rows: string[]): string => [HEADER, COLUMNS, ...rows, "*", ""].join("\n");

test("the banner, the header and the terminator are not servers", () => {
    const servers = parseVpngateCsv(csv(row("public-vpn-64", "219.100.37.23", "2964483", "JP")));
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ host: "public-vpn-64", ip: "219.100.37.23", country: "JP", score: 2964483 });
});

test("country codes are normalised so one country is one country", () => {
    const servers = parseVpngateCsv(csv(row("a", "1.1.1.1", "1", "jp"), row("b", "2.2.2.2", "2", "JP")));
    expect(servers.map((server) => server.country)).toEqual(["JP", "JP"]);
});

test("a truncated row is dropped rather than half-read", () => {
    // A short transfer is the realistic failure against a volunteer-funded endpoint, and half a row parsed as
    // a server is a dial that fails much later with nothing to point at.
    const servers = parseVpngateCsv(csv("only,three,fields", row("good", "1.2.3.4", "5", "KR")));
    expect(servers.map((server) => server.host)).toEqual(["good"]);
});

test("a row with no config is dropped: there is nothing to dial", () => {
    const servers = parseVpngateCsv(csv(row("empty", "1.2.3.4", "5", "KR", ""), row("good", "5.6.7.8", "9", "JP")));
    expect(servers.map((server) => server.host)).toEqual(["good"]);
});

test("an unparseable score does not lose the server", () => {
    // Score only affects RANKING. Dropping a dialable server because one field was odd would be a worse trade.
    const servers = parseVpngateCsv(csv(row("odd", "1.2.3.4", "not-a-number", "JP")));
    expect(servers[0]?.score).toBe(0);
    expect(servers[0]?.host).toBe("odd");
});

test("an empty or garbage body yields no servers rather than throwing", () => {
    expect(parseVpngateCsv("")).toEqual([]);
    expect(parseVpngateCsv("<html>we are down</html>")).toEqual([]);
    expect(parseVpngateCsv([HEADER, COLUMNS, "*", ""].join("\n"))).toEqual([]);
});
