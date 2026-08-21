import { beforeEach, expect, test } from "vitest";
import { exitControlPort, exitProxyPort } from "./exit-paths.js";
import { exitNodesLine, torrc } from "./tor.js";

/* HOME decides where the generated torrc and its data directory would land. Pinned to a literal rather than a
 * temp directory because nothing here touches the filesystem: torrc() is a pure function of an id and a
 * country, and creating a directory to test a string would make this an integration test for no gain. */
beforeEach(() => {
    process.env["HOME"] = "/tmp/exit-tor-home";
});

test("StrictNodes accompanies every country, always", () => {
    /* THE line that makes a tor exit trustworthy. Without StrictNodes, ExitNodes is a PREFERENCE: tor will
     * happily leave from somewhere else when the country is congested, and the switch would silently be a lie.
     * With it, tor fails to build a circuit instead, which the verification then reports honestly. */
    expect(exitNodesLine("DE")).toBe("ExitNodes {de}\nStrictNodes 1\n");
    expect(exitNodesLine("de")).toBe("ExitNodes {de}\nStrictNodes 1\n");
    // No country asked for = no constraint, which is both faster and kinder to a volunteer network.
    expect(exitNodesLine(undefined)).toBe("");
});

test("the generated torrc binds to loopback on the exit's own derived ports", () => {
    const conf = torrc("berlin", "DE");
    expect(conf).toContain(`SocksPort 127.0.0.1:${exitProxyPort("berlin")}`);
    expect(conf).toContain(`ControlPort 127.0.0.1:${exitControlPort("berlin")}`);
    // Loopback only. A proxy into another country reachable off-box is an open relay, and an open relay is how
    // an address range gets burned for everyone using it.
    expect(conf).not.toMatch(/SocksPort 0\.0\.0\.0/);
    expect(conf).toContain("SocksPolicy accept 127.0.0.1/32");
    expect(conf).toContain("SocksPolicy reject *");
});

test("the torrc authenticates its control port and never relays for anybody", () => {
    const conf = torrc("berlin", undefined);
    // Cookie auth, so nothing else in the container can drive this tor by connecting to its control port.
    expect(conf).toContain("CookieAuthentication 1");
    expect(conf).toMatch(/CookieAuthFile \S+/);
    // ClientOnly: this sandbox carries no one else's traffic. An exit relay's address answers for whatever
    // leaves it, which is not a liability to take on by accident.
    expect(conf).toContain("ClientOnly 1");
});

test("two exits cannot share a tor data directory or a port", () => {
    // Tor requires an exclusive 0700 DataDirectory, and two tors on one control port would take each other's
    // commands: one exit asked for Japan, the other quietly moved.
    const berlin = torrc("berlin", "DE");
    const osaka = torrc("osaka", "JP");
    expect(berlin).not.toBe(osaka);
    const dataDir = (conf: string) => /DataDirectory (\S+)/.exec(conf)?.[1];
    expect(dataDir(berlin)).not.toBe(dataDir(osaka));
    expect(exitControlPort("berlin")).not.toBe(exitControlPort("osaka"));
});
