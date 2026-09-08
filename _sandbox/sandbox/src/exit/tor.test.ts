import { beforeEach, expect, test } from "vitest";
import { exitControlPort, exitProxyPort } from "./exit-paths.js";
import { exitNodesLine, torrc } from "./tor.js";

// HOME decides where the generated torrc/data dir would land; a literal, not a temp dir, since torrc() is a pure
// function and nothing here touches the filesystem.
beforeEach(() => {
    process.env["HOME"] = "/tmp/exit-tor-home";
});

test("StrictNodes accompanies every country, always", () => {
    // Without StrictNodes, ExitNodes is only a preference; tor could leave from elsewhere and silently lie.
    expect(exitNodesLine("DE")).toBe("ExitNodes {de}\nStrictNodes 1\n");
    expect(exitNodesLine("de")).toBe("ExitNodes {de}\nStrictNodes 1\n");
    // No country requested means no constraint, faster and kinder to the volunteer network.
    expect(exitNodesLine(undefined)).toBe("");
});

test("the generated torrc binds to loopback on the exit's own derived ports", () => {
    const conf = torrc("berlin", "DE");
    expect(conf).toContain(`SocksPort 127.0.0.1:${exitProxyPort("berlin")}`);
    expect(conf).toContain(`ControlPort 127.0.0.1:${exitControlPort("berlin")}`);
    expect(conf).not.toMatch(/SocksPort 0\.0\.0\.0/);
    expect(conf).toContain("SocksPolicy accept 127.0.0.1/32");
    expect(conf).toContain("SocksPolicy reject *");
});

test("the torrc authenticates its control port and never relays for anybody", () => {
    const conf = torrc("berlin", undefined);
    // Cookie auth: nothing else in the container can drive this tor by connecting to its control port.
    expect(conf).toContain("CookieAuthentication 1");
    expect(conf).toMatch(/CookieAuthFile \S+/);
    expect(conf).toContain("ClientOnly 1");
});

test("two exits cannot share a tor data directory or a port", () => {
    // Two tors sharing one control port take each other's commands: one asked for Japan, the other quietly moved.
    const berlin = torrc("berlin", "DE");
    const osaka = torrc("osaka", "JP");
    expect(berlin).not.toBe(osaka);
    const dataDir = (conf: string) => /DataDirectory (\S+)/.exec(conf)?.[1];
    expect(dataDir(berlin)).not.toBe(dataDir(osaka));
    expect(exitControlPort("berlin")).not.toBe(exitControlPort("osaka"));
});
