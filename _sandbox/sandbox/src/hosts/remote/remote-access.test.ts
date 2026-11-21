import { createHmac } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { netdUplinks } from "./netd-uplinks.js";
import { createRemoteAccess, iceUrlsOf } from "./remote-access.js";
import { digestOf } from "./remote-keys.js";
import { ALL_ON, fakeLink, fakeRemoted, infoWith, memoryKeys, NOW, remoteHarness, SERVICE_NOT_SET_UP } from "./remote-access.testing.js";

const owner = { actor: { kind: "member", email: "owner@example.com", role: "owner" }, full: true } as const;
const viewer = { actor: { kind: "member", email: "vic@example.com", role: "viewer" }, full: false } as const;

const ClaimsSchema = z.strictObject({ s: z.string(), exp: z.number(), ro: z.boolean(), iat: z.number() });

// A token's claims as remoted reads them, after checking its MAC under the device's media key.
const claimsOf = (token: string, mediaKey: string): z.infer<typeof ClaimsSchema> => {
    const [payload = "", mac = ""] = token.split(".");
    const bytes = Buffer.from(payload, "base64url");
    expect(createHmac("sha256", Buffer.from(mediaKey, "base64url")).update(bytes).digest("base64url")).toBe(mac);
    return ClaimsSchema.parse(JSON.parse(bytes.toString("utf8")));
};

const refusal = async (promise: Promise<unknown>): Promise<{ readonly code: string; readonly message: string }> => {
    try {
        await promise;
    } catch (error) {
        if (error instanceof ORPCError) {
            return { code: error.code, message: error.message };
        }
        throw error;
    }
    throw new Error("expected a refusal");
};

describe("opening a screen", () => {
    test("starts the device once with its pair, registers the token's digest with netd and mints the media token", async () => {
        const { remote, link, keys, netd, audit } = remoteHarness();
        const [first, second] = await Promise.all([remote.openScreen("rog", undefined, owner), remote.openScreen("rog", "0", owner)]);
        expect([...keys.made.keys()]).toEqual(["rog"]);
        const pair = keys.made.get("rog") ?? { uplinkToken: "", mediaKey: "" };
        // The setting's STUN servers go with the pair, for remoted's own gathering.
        expect(link.starts).toEqual([
            { device: "rog", uplinkToken: pair.uplinkToken, mediaKey: pair.mediaKey, iceServers: ["stun:stun.example.test:3478"] },
        ]);
        expect(netd.told).toEqual([{ kind: "deviceUplink", device: "rog", tokenSha256: digestOf(pair.uplinkToken) }]);
        // The primary monitor unless one is asked for.
        expect(first).toEqual({
            session: "screen-1",
            path: "/system/device-media/rog/screen-1",
            token: first.token,
            expiresAt: NOW + 120_000,
            readOnly: false,
            iceServers: [{ urls: ["stun:stun.example.test:3478"] }],
        });
        expect(claimsOf(first.token, pair.mediaKey)).toEqual({ s: "media/screen-1", exp: NOW + 120_000, ro: false, iat: NOW });
        expect(second.session).toBe("screen-0");
        // The two opens raced on one start: each recorded, in whichever order they finished.
        const recorded = audit.map((event) => [event.action, event.target, event.details]).toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        expect(recorded).toEqual([
            ["device.remote.screen.open", "rog", { session: "screen-0", readOnly: false }],
            ["device.remote.screen.open", "rog", { session: "screen-1", readOnly: false }],
        ]);
    });

    test("is read-only for a member below Full access, and for anyone where the device does not allow control", async () => {
        const watched = await remoteHarness().remote.openScreen("rog", undefined, viewer);
        expect(watched.readOnly).toBe(true);
        const uncontrolled = await remoteHarness({ info: infoWith({ ...ALL_ON, control: false }) }).remote.openScreen("rog", undefined, owner);
        expect(uncontrolled.readOnly).toBe(true);
    });

    test("an uplink already up is asked what it serves, and the agent is not started again", async () => {
        const { remote, link, netd } = remoteHarness();
        netd.up("rog");
        await remote.openScreen("rog", undefined, owner);
        expect(link.starts).toEqual([]);
    });

    test("an unknown monitor is not found, and a device that refused leaves nothing registered", async () => {
        expect(await refusal(remoteHarness().remote.openScreen("rog", "7", owner))).toMatchObject({ code: "NOT_FOUND" });
        const { remote, keys, netd } = remoteHarness({ refused: "every remote switch is off" });
        expect(await refusal(remote.openScreen("rog", undefined, owner))).toEqual({
            code: "CONFLICT",
            message: `"rog" did not start its remote access: every remote switch is off`,
        });
        expect(netd.told.map((message) => message.kind)).toEqual(["deviceUplink", "deviceWithdraw"]);
        expect(keys.made.has("rog")).toBe(false);
    });

    test("nothing is registered with a netd that never reported device uplinks", async () => {
        const told: unknown[] = [];
        const remote = createRemoteAccess({
            link: fakeLink(),
            keys: memoryKeys(),
            control: () => fakeRemoted().control,
            iceServers: async () => [],
            audit: () => undefined,
            logger: { info: () => undefined, warn: () => undefined },
        });
        remote.useNetd(netdUplinks((message) => told.push(message)));
        const refused = await refusal(remote.openScreen("rog", undefined, owner));
        expect(refused.code).toBe("CONFLICT");
        expect(refused.message).toContain("too old to carry a remote screen");
        expect(told).toEqual([]);
        remote.stop();
    });
});

describe("terminals", () => {
    test("Full access opens one under a fresh session, remoted makes it, and the token names it", async () => {
        const { remote, keys, remoted, audit } = remoteHarness();
        const opened = await remote.openTerminal({ device: "rog", environment: "wsl:archlinux", cols: 120, rows: 30 }, owner);
        expect(opened.session).toMatch(/^t-[A-Za-z0-9_-]{16}$/u);
        expect(opened.path).toBe(`/system/device-terminal/rog/${opened.session}`);
        expect(remoted.asked).toEqual([{ session: opened.session, environment: "wsl:archlinux", shell: undefined, cwd: undefined, cols: 120, rows: 30 }]);
        expect(claimsOf(opened.token, keys.made.get("rog")?.mediaKey ?? "")).toEqual({ s: `terminal/${opened.session}`, exp: NOW + 120_000, ro: false, iat: NOW });
        expect(audit.at(-1)).toMatchObject({ action: "device.remote.terminal.open", target: "rog", details: { session: opened.session, environment: "wsl:archlinux" } });

        const again = await remote.attachTerminal("rog", opened.session, owner);
        expect(again.path).toBe(opened.path);
        await remote.closeTerminal("rog", opened.session, owner);
        expect(remoted.terminals.size).toBe(0);
        expect(audit.map((event) => event.action)).toEqual(["device.remote.terminal.open", "device.remote.terminal.attach", "device.remote.terminal.close"]);
        expect(await refusal(remote.attachTerminal("rog", opened.session, owner))).toMatchObject({ code: "NOT_FOUND" });
    });

    test("a member below Full access opens, refreshes and closes none", async () => {
        const { remote, remoted } = remoteHarness();
        expect(await refusal(remote.openTerminal({ device: "rog", cols: 80, rows: 24 }, viewer))).toMatchObject({ code: "FORBIDDEN" });
        expect(await refusal(remote.refresh("rog", "t-abc", viewer))).toMatchObject({ code: "FORBIDDEN" });
        expect(await refusal(remote.closeTerminal("rog", "t-abc", viewer))).toMatchObject({ code: "FORBIDDEN" });
        expect(remoted.asked).toEqual([]);
    });

    test("a device without terminals switched on, or a remoted at its limit, opens none", async () => {
        const off = remoteHarness({ info: infoWith({ ...ALL_ON, terminal: false }) });
        expect(await refusal(off.remote.openTerminal({ device: "rog", cols: 80, rows: 24 }, owner))).toEqual({ code: "CONFLICT", message: `Terminals are off on "rog".` });
        const full = remoteHarness();
        full.remoted.refuseNext(429, "16 terminals are open already");
        expect(await refusal(full.remote.openTerminal({ device: "rog", cols: 80, rows: 24 }, owner))).toEqual({
            code: "CONFLICT",
            message: `"rog" did not open a terminal: 16 terminals are open already`,
        });
    });
});

describe("environments: each connection's own remoted serves its own", () => {
    // The Linux remoted beside a distro's own agent: it calls its environment `native`, and has no screen of the PC's.
    const distroInfo = { ...infoWith(), monitors: [], environments: ["native"] };

    test("a distro's own connection opens a native shell there, named as the PC names it, under an uplink id netd can route", async () => {
        const { remote, remoted, netd, audit } = remoteHarness({ info: distroInfo });
        const opened = await remote.openTerminal({ device: "rog::wsl:archlinux", environment: "wsl:archlinux", cols: 80, rows: 24 }, owner);
        expect(opened.path).toMatch(/^\/system\/device-terminal\/rog-wsl-archlinux-[0-9a-f]{8}\/t-[A-Za-z0-9_-]{16}$/u);
        const unasked = await remote.openTerminal({ device: "rog::wsl:archlinux", cols: 80, rows: 24 }, owner);
        // Its own environment is remoted's own: nothing is asked of it, so no `wsl.exe -d` is ever involved.
        expect(remoted.asked.map((asked) => asked.environment)).toEqual([undefined, undefined]);
        expect(audit.at(-1)?.details).toEqual({ session: unasked.session, environment: "wsl:archlinux" });
        netd.up(opened.path.split("/")[3] ?? "");
        const status = await remote.status("rog::wsl:archlinux", owner);
        expect([status.environments, status.monitors, status.terminals.map((terminal) => terminal.environment)]).toEqual([
            ["wsl:archlinux"],
            [],
            ["wsl:archlinux", "wsl:archlinux"],
        ]);
    });

    test("a distro's connection shows no screen and opens no other environment's shell", async () => {
        const { remote, link } = remoteHarness({ info: distroInfo });
        expect(await refusal(remote.openScreen("rog::wsl:archlinux", undefined, owner))).toEqual({
            code: "CONFLICT",
            message: `"rog::wsl:archlinux" is a WSL distro: the computer's screen is its Windows side's. Open it on "rog".`,
        });
        expect((await refusal(remote.openTerminal({ device: "rog::wsl:archlinux", environment: "native", cols: 80, rows: 24 }, owner))).code).toBe("CONFLICT");
        expect(link.starts).toEqual([]);
    });

    test("the Windows side leaves out, and refuses, a distro with a connection of its own; one without stays reachable", async () => {
        const { remote, remoted, netd } = remoteHarness({ ownConnections: ["wsl:archlinux"], info: { ...infoWith(), environments: ["native", "wsl:archlinux", "wsl:Ubuntu"] } });
        expect(await refusal(remote.openTerminal({ device: "rog", environment: "wsl:archlinux", cols: 80, rows: 24 }, owner))).toEqual({
            code: "CONFLICT",
            message: "wsl:archlinux has a connection of its own on this computer; open its terminal there.",
        });
        await remote.openTerminal({ device: "rog", environment: "native", cols: 80, rows: 24 }, owner);
        await remote.openTerminal({ device: "rog", environment: "wsl:Ubuntu", cols: 80, rows: 24 }, owner);
        expect(remoted.asked.map((asked) => asked.environment)).toEqual([undefined, "wsl:Ubuntu"]);
        netd.up("rog");
        expect((await remote.status("rog", owner)).environments).toEqual(["native", "wsl:Ubuntu"]);
    });
});

describe("status and refresh", () => {
    test("says why nothing can open, and starts nothing", async () => {
        const offline = remoteHarness({ offline: true });
        expect(await offline.remote.status("rog", owner)).toEqual({
            available: false,
            reason: `"rog" is not connected right now`,
            allow: ALL_ON,
            monitors: [],
            environments: [],
            terminals: [],
        });
        const off = remoteHarness({ card: { view: false, control: false, terminal: false } });
        const said = await off.remote.status("rog", viewer);
        expect([said.available, said.reason]).toEqual([false, `Watching the screen is off on "rog". Its owner can turn it on on the device's card.`]);
        expect(off.link.starts).toEqual([]);
    });

    test("reads remoted while its uplink is up, terminals for Full access only", async () => {
        const { remote, netd } = remoteHarness();
        const opened = await remote.openTerminal({ device: "rog", cols: 80, rows: 24 }, owner);
        netd.up("rog");
        const status = await remote.status("rog", owner);
        expect([status.available, status.monitors.length, status.environments, status.terminals.map((terminal) => terminal.session)]).toEqual([
            true,
            2,
            ["native", "wsl:archlinux"],
            [opened.session],
        ]);
        expect((await remote.status("rog", viewer)).terminals).toEqual([]);
    });

    test("a screen's fresher token is read-only as its open was, and a device never started has none", async () => {
        const { remote, keys } = remoteHarness();
        await remote.openScreen("rog", undefined, owner);
        const mediaKey = keys.made.get("rog")?.mediaKey ?? "";
        expect(claimsOf((await remote.refresh("rog", "screen-1", owner)).token, mediaKey)).toMatchObject({ s: "media/screen-1", ro: false });
        expect(claimsOf((await remote.refresh("rog", "screen-1", viewer)).token, mediaKey)).toMatchObject({ s: "media/screen-1", ro: true });
        expect(await refusal(remote.refresh("omen", "screen-1", owner))).toMatchObject({ code: "NOT_FOUND" });
        expect(await refusal(remote.refresh("rog", "other", owner))).toMatchObject({ code: "NOT_FOUND" });
    });
});

test("what an earlier daemon left registered without keys here is withdrawn, and a revocation drops every uplink's viewers", async () => {
    const { remote, netd, remoted } = remoteHarness();
    await remote.openScreen("rog", undefined, owner);
    netd.up("stale");
    netd.down("omen");
    expect(netd.told.filter((message) => message.kind === "deviceWithdraw")).toEqual([
        { kind: "deviceWithdraw", device: "stale" },
        { kind: "deviceWithdraw", device: "stale" },
        { kind: "deviceWithdraw", device: "omen" },
    ]);
    await remote.dropViewers("a member's access was revoked");
    // rog and the stale uplink are up; omen's is not, and is not asked.
    expect(remoted.drops).toEqual(["a member's access was revoked", "a member's access was revoked"]);
});

describe("the STUN servers remoted is handed", () => {
    test("are the setting's URLs, each once, and none for an empty setting", () => {
        expect(
            iceUrlsOf([
                { urls: ["stun:a.example:3478", "stun:b.example:3478"] },
                { urls: ["stun:a.example:3478"], username: "u", credential: "c" },
            ]),
        ).toEqual(["stun:a.example:3478", "stun:b.example:3478"]);
        expect(iceUrlsOf([])).toEqual([]);
    });
});

describe("a Windows computer's lock-screen service", () => {
    const installed = { supported: true, installed: true, state: "running", version: "1.431.0", agentVersion: "1.431.0", outOfDate: false, helper: null };

    test("is read for anyone, asking the agent for its status and recording nothing", async () => {
        const { remote, link, audit } = remoteHarness();
        expect(await remote.service("rog", viewer)).toEqual(SERVICE_NOT_SET_UP);
        expect(link.services).toEqual([{ device: "rog", action: "status" }]);
        expect(audit).toEqual([]);
    });

    test("is set up and removed with Full access alone, each recorded with how it ended", async () => {
        const { remote, link, audit } = remoteHarness({ service: installed });
        expect(await refusal(remote.changeService("rog", "install", viewer))).toEqual({
            code: "FORBIDDEN",
            message: "only someone with Full access to this sandbox can set up the lock-screen service on the owner's computers",
        });
        expect(link.services).toEqual([]);
        expect(await remote.changeService("rog", "install", owner)).toEqual(installed);
        expect(link.services).toEqual([{ device: "rog", action: "install" }]);
        expect(audit.map((event) => [event.action, event.target, event.details])).toEqual([
            ["device.remote.service.install", "rog", { outcome: "done", installed: true }],
        ]);
    });

    test("a no on the computer is recorded as declined; a computer that cannot be asked is a conflict in its words", async () => {
        const declined = remoteHarness({ service: { ...SERVICE_NOT_SET_UP, declined: true } });
        expect(await declined.remote.changeService("rog", "uninstall", owner)).toMatchObject({ declined: true });
        expect(declined.audit.map((event) => event.details)).toEqual([{ outcome: "declined", installed: false }]);
        const old = remoteHarness({ refused: `The agent on "rog" cannot set up the lock screen and administrator prompts: it is not on Windows, or too old.` });
        expect(await refusal(old.remote.service("rog", owner))).toEqual({
            code: "CONFLICT",
            message: `The agent on "rog" cannot set up the lock screen and administrator prompts: it is not on Windows, or too old.`,
        });
        await refusal(old.remote.changeService("rog", "install", owner));
        expect(old.audit.map((event) => [event.action, event.details])).toEqual([
            ["device.remote.service.install", { outcome: "failed", reason: `The agent on "rog" cannot set up the lock screen and administrator prompts: it is not on Windows, or too old.` }],
        ]);
    });
});
