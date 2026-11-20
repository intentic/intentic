import { DeviceScopesSchema } from "@intentic/sandbox-contract/schemas/capabilities";
import { DEV_VERSION } from "@intentic/sandbox-contract/state/versions";
import { exitWords } from "./remoted.js";
import { REMOTED_BIN_ENV, type RemotedBinaryIo, remotedCanExist, remotedPublishedFor, RemotedUnavailable, resolveRemoted } from "./remoted-binary.js";
import {
    allowFrom,
    EMPTY_REMOTED_CONFIG,
    parseStatusLine,
    type RemotedConfig,
    type RemotedUplink,
    withAllow,
    withoutUplinks,
    withUplink,
} from "./remoted-files.js";

/* What the agent writes for intentic-remoted and reads back from it, without a remoted: what a link's switches allow,
   one uplink per link in the config, a status line read forward-compatibly, and which remoted is started. */

const uplink = (id: string, over: Partial<RemotedUplink> = {}): RemotedUplink => ({
    id,
    url: `${id}`.replace("https://", "http://127.0.0.1:7/"),
    device: "rog",
    uplinkToken: "tok",
    mediaKey: "k".repeat(43),
    allow: { view: true, control: false, terminal: false },
    generation: 1,
    ...over,
});
const ALPHA = "https://alpha.example.dev";
const BETA = "https://beta.example.dev";
const config = (...uplinks: RemotedUplink[]): RemotedConfig => ({ ...EMPTY_REMOTED_CONFIG, uplinks });

describe("what a link's switches allow", () => {
    test("each of the three people switches is its own permission, and the agents' switches are none of them", () => {
        const agentsAll = DeviceScopesSchema.parse({
            shell: "on",
            write: "on",
            screen: "on",
            control: "on",
            sandboxes: "on",
            destructive: "on",
            programs: "on",
        });
        expect(allowFrom(agentsAll)).toEqual({ view: false, control: false, terminal: false });
        expect(allowFrom({ ...agentsAll, remoteView: "on" })).toEqual({ view: true, control: false, terminal: false });
        expect(allowFrom({ ...agentsAll, remoteControl: "on" })).toEqual({ view: false, control: true, terminal: false });
        expect(allowFrom({ ...agentsAll, remoteTerminal: "on" })).toEqual({ view: false, control: false, terminal: true });
    });

    // device.json caches each link's last grant, and a grant cached by an agent from before the switches has none of them.
    test("a grant cached before the switches existed allows nothing", () => {
        expect(allowFrom({})).toEqual({ view: false, control: false, terminal: false });
    });
});

describe("one uplink per link", () => {
    test("a link's uplink replaces the one it had, and leaves the other links' alone", () => {
        const before = config(uplink(ALPHA), uplink(BETA));
        const after = withUplink(before, uplink(ALPHA, { uplinkToken: "fresh", generation: 2 }));
        expect(after.uplinks).toEqual([uplink(BETA), uplink(ALPHA, { uplinkToken: "fresh", generation: 2 })]);
    });

    test("a link's uplink goes, and nothing else does", () => {
        const before = { ...config(uplink(ALPHA), uplink(BETA)), paused: true, notBefore: 1_763_650_000_000 };
        expect(withoutUplinks(before, new Set([ALPHA]))).toEqual({ paused: true, notBefore: 1_763_650_000_000, uplinks: [uplink(BETA)] });
    });

    test("a switch change rewrites what its uplink allows, and the uplink goes once it allows nothing", () => {
        const before = config(uplink(ALPHA), uplink(BETA));
        expect(withAllow(before, ALPHA, { view: true, control: true, terminal: false }).uplinks).toEqual([
            uplink(BETA),
            uplink(ALPHA, { allow: { view: true, control: true, terminal: false } }),
        ]);
        expect(withAllow(before, ALPHA, { view: false, control: false, terminal: false }).uplinks).toEqual([uplink(BETA)]);
    });

    // The same object back is how the writer knows to leave the file alone.
    test("a grant that changes nothing, or names a link with no uplink, is the same config", () => {
        const before = config(uplink(ALPHA));
        expect(withAllow(before, ALPHA, { view: true, control: false, terminal: false })).toBe(before);
        expect(withAllow(before, BETA, { view: true, control: true, terminal: true })).toBe(before);
    });
});

describe("remoted's status line", () => {
    const LINE = {
        type: "status" as const,
        version: "1.2.3",
        pid: 4242,
        uplinks: [{ id: ALPHA, state: "up", since: 1_763_650_000_000 }],
        people: [{ uplink: ALPHA, kind: "terminal", session: "t-abc", readOnly: false, since: 1_763_650_000_000 }],
        terminals: 2,
        environments: ["native", "wsl:Ubuntu"],
        monitors: [],
    };

    test("a status line is read whole", () => {
        expect(parseStatusLine(JSON.stringify(LINE))).toEqual(LINE);
    });

    test("a field, a state or a kind a newer remoted adds is read with the rest", () => {
        const newer = {
            ...LINE,
            uplinks: [{ id: ALPHA, state: "parked", since: 1, extra: true }],
            people: [{ uplink: ALPHA, kind: "file-transfer", session: "f-1", since: 2 }],
            cursor: { x: 1 },
        };
        expect(parseStatusLine(JSON.stringify(newer))).toEqual(newer);
    });

    test("a line that is not a status is nothing: plain words, another type, a status missing what is read", () => {
        expect(parseStatusLine("2026-11-20T13:00:00Z INFO remoted: listening")).toBeUndefined();
        expect(parseStatusLine(JSON.stringify({ ...LINE, type: "metrics" }))).toBeUndefined();
        const { people: _gone, ...noPeople } = LINE;
        expect(parseStatusLine(JSON.stringify(noPeople))).toBeUndefined();
        expect(parseStatusLine("{not json")).toBeUndefined();
    });
});

describe("which remoted is started", () => {
    const io = (over: Partial<RemotedBinaryIo> = {}): RemotedBinaryIo & { fetched: string[] } => {
        const fetched: string[] = [];
        return {
            env: {},
            platform: "linux",
            arch: "x64",
            exists: () => false,
            localBuild: () => undefined,
            versionOf: () => undefined,
            fetch: async (version, path) => void fetched.push(`${version} → ${path}`),
            log: () => undefined,
            ...over,
            fetched,
        };
    };
    const TARGET = "/home/me/.intentic/machine/bin/intentic-remoted";

    test("published for Windows and Linux on amd64, and Linux on arm64, and nothing else", () => {
        expect(remotedPublishedFor("win32", "x64")).toBe(true);
        expect(remotedPublishedFor("linux", "x64")).toBe(true);
        expect(remotedPublishedFor("linux", "arm64")).toBe(true);
        expect(remotedPublishedFor("win32", "arm64")).toBe(false);
        expect(remotedPublishedFor("darwin", "arm64")).toBe(false);
    });

    test("advertised where one can be had: an override, one already in bin/, or a published platform", () => {
        expect(remotedCanExist({}, false, "darwin", "arm64")).toBe(false);
        expect(remotedCanExist({ [REMOTED_BIN_ENV]: "/opt/remoted" }, false, "darwin", "arm64")).toBe(true);
        expect(remotedCanExist({ [REMOTED_BIN_ENV]: "" }, false, "darwin", "arm64")).toBe(false);
        expect(remotedCanExist({}, true, "darwin", "arm64")).toBe(true);
        expect(remotedCanExist({}, false, "linux", "arm64")).toBe(true);
    });

    test("the override wins in every build, and one that names nothing is refused", async () => {
        const fake = io({ env: { [REMOTED_BIN_ENV]: "/opt/fake-remoted" }, exists: (path) => path === "/opt/fake-remoted" });
        expect(await resolveRemoted("1.400.0", fake, TARGET)).toBe("/opt/fake-remoted");
        await expect(resolveRemoted("1.400.0", io({ env: { [REMOTED_BIN_ENV]: "/opt/gone" } }), TARGET)).rejects.toThrow(
            new RemotedUnavailable(`${REMOTED_BIN_ENV} names /opt/gone, which does not exist on this computer.`),
        );
        expect(fake.fetched).toEqual([]);
    });

    test("a from-source agent takes its checkout's build and never downloads", async () => {
        const built = io({ localBuild: () => "/checkout/_devices/remoted/target/release/intentic-remoted" });
        expect(await resolveRemoted(DEV_VERSION, built, TARGET)).toBe("/checkout/_devices/remoted/target/release/intentic-remoted");
        const none = io({ exists: () => true, versionOf: () => DEV_VERSION });
        await expect(resolveRemoted(DEV_VERSION, none, TARGET)).rejects.toThrow(/built from source \(0\.0\.0\).*cargo build --release/);
        expect([...built.fetched, ...none.fetched]).toEqual([]);
    });

    test("the one in bin/ is started when it answers this agent's version, and fetched when it answers another or none", async () => {
        const current = io({ exists: () => true, versionOf: () => "1.400.0" });
        expect(await resolveRemoted("1.400.0", current, TARGET)).toBe(TARGET);
        expect(current.fetched).toEqual([]);

        const older = io({ exists: () => true, versionOf: () => "1.399.0" });
        expect(await resolveRemoted("1.400.0", older, TARGET)).toBe(TARGET);
        expect(older.fetched).toEqual([`1.400.0 → ${TARGET}`]);

        const missing = io();
        expect(await resolveRemoted("1.400.0", missing, TARGET)).toBe(TARGET);
        expect(missing.fetched).toEqual([`1.400.0 → ${TARGET}`]);
    });

    test("a fetch that fails, or a platform with no release of it, is refused saying why", async () => {
        const failing = io({
            fetch: async () => await Promise.reject(new Error("the SHA256SUMS of v1.400.0 lists no intentic-remoted-linux-amd64")),
        });
        await expect(resolveRemoted("1.400.0", failing, TARGET)).rejects.toThrow(
            "intentic-remoted 1.400.0 could not be fetched (the SHA256SUMS of v1.400.0 lists no intentic-remoted-linux-amd64).",
        );
        await expect(resolveRemoted("1.400.0", io({ platform: "darwin", arch: "arm64" }), TARGET)).rejects.toThrow(
            "no intentic-remoted is published for darwin on arm64, so people cannot reach this computer remotely.",
        );
    });
});

test("an exit is said with its code or signal and the last line remoted wrote", () => {
    expect(exitWords({ code: 3, signal: null }, "2026-11-20T13:00:01Z ERROR remoted: uplink table poisoned")).toBe(
        "exited with code 3; its last line: 2026-11-20T13:00:01Z ERROR remoted: uplink table poisoned",
    );
    expect(exitWords({ code: null, signal: "SIGKILL" }, undefined)).toBe("was ended by SIGKILL");
    expect(exitWords({ code: -2, signal: null, error: "could not run (spawn EACCES)" }, undefined)).toBe("could not run (spawn EACCES)");
});
