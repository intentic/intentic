import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceScopesSchema, type DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import { requires } from "@intentic/testing/requires";
import type { HostLink } from "../config.js";
import type { PersonOnScreen } from "../indicator.js";
import { createRemote, type Remote, type RemoteSeams } from "./remote.js";
import { REMOTED_BIN_ENV, realRemotedIo, resolveRemoted } from "./remoted-binary.js";
import { readRemotedConfig, readRemotedStatus, type RemotedConfig, type RemotedStatus } from "./remoted-files.js";
import { spawnRemoted } from "./remoted-spawn.js";

/* The supervisor over a real child: a FAKE intentic-remoted, a script that reads the config it is handed as remoted does,
   reports every uplink `up` unless its address says it is unreachable, echoes what each allows and the pause back in its
   status, leaves when its stdin closes, and exits with code 3 when a `crash` file appears beside its config. People are
   whatever a `people.json` beside the config lists. A POSIX shebang script, so not on Windows. */

const posix = requires(process.platform !== "win32", "a POSIX shebang script standing in for intentic-remoted");

// What the fake prints besides the contract's status, to show what reached it.
type FakeStatus = RemotedStatus & {
    readonly allow: RemotedConfig["uplinks"][number]["allow"][];
    readonly paused: boolean;
    readonly notBefore: number;
};

const FAKE = `#!${process.execPath}
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "version") { console.log("0.0.0"); process.exit(0); }
const config = args[args.indexOf("--config") + 1];
const dir = dirname(config);
console.error("2026-11-20T13:00:00Z INFO remoted: fake listening");
const since = new Map();
let last = "";
const read = (path, fallback) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } };
const tick = () => {
    if (existsSync(join(dir, "crash"))) {
        rmSync(join(dir, "crash"));
        console.error("2026-11-20T13:00:01Z ERROR remoted: told to crash");
        process.exit(3);
    }
    const cfg = read(config, { paused: false, notBefore: 0, uplinks: [] });
    const uplinks = cfg.uplinks.map((u) => {
        const state = u.url.includes("unreachable") ? "down" : "up";
        const key = u.id + state + u.generation;
        if (!since.has(key)) since.set(key, Date.now());
        return { id: u.id, state, generation: u.generation, since: since.get(key), ...(state === "down" ? { error: "connection refused" } : {}) };
    });
    const status = {
        type: "status", version: "0.0.0", pid: process.pid, uplinks, people: read(join(dir, "people.json"), []), terminals: 0,
        environments: ["native"], monitors: [{ id: "1", name: "one", x: 0, y: 0, width: 1920, height: 1080, scale: 1.5, primary: true, refresh: 60 }],
        allow: cfg.uplinks.map((u) => u.allow), paused: cfg.paused, notBefore: cfg.notBefore,
    };
    const line = JSON.stringify(status);
    if (line !== last) { last = line; process.stdout.write("words that are not a status\\n" + line + "\\n"); }
};
tick();
setInterval(tick, 50);
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
`;

const ALPHA = "https://alpha.example.dev";
const BETA = "https://beta.example.dev";
const KEY = "k".repeat(43);

let dir: string;
let script: string;
let remote: Remote | undefined;

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "intentic-remoted-"));
    script = join(dir, "fake-remoted.mjs");
    await writeFile(script, FAKE);
    await chmod(script, 0o755);
});
afterAll(async () => await rm(dir, { recursive: true, force: true }));

afterEach(async () => {
    await remote?.shutdown();
    remote = undefined;
    for (const name of ["remoted.json", "remoted-status.json", "people.json", "crash"]) {
        await rm(join(dir, name), { force: true });
    }
});

const grant = (over: Partial<DeviceScopes>): DeviceScopes => DeviceScopesSchema.parse(over);

const harness = (over: Partial<RemoteSeams> = {}) => {
    const logged: string[] = [];
    const audited: { tool: string; ok: boolean; detail: string }[] = [];
    const shown: (readonly PersonOnScreen[])[] = [];
    let paused = false;
    const log = (message: string): void => void logged.push(message);
    const seams: RemoteSeams = {
        binary: async (said) => await resolveRemoted("1.400.0", { ...realRemotedIo(said), env: { [REMOTED_BIN_ENV]: script } }),
        // The fake reads its verdict off the address, so a sandbox's resolved address is what decides it.
        resolveBase: async (sandboxUrl) => ({ base: sandboxUrl.replace("https://", "http://127.0.0.1:9/"), local: false }),
        spawn: spawnRemoted,
        paused: async () => paused,
        people: (people) => void shown.push(people),
        audit: async (entry) => void audited.push(entry),
        configPath: join(dir, "remoted.json"),
        statusPath: join(dir, "remoted-status.json"),
        now: Date.now,
        ...over,
    };
    remote = createRemote(seams, log);
    return { remote, logged, audited, shown, setPaused: (next: boolean) => void (paused = next) };
};

const config = async (): Promise<RemotedConfig | undefined> => await readRemotedConfig(join(dir, "remoted.json"));
// SAFETY: the fake remoted above prints the contract's status plus these three fields, and nothing else on that line
const fakeStatus = (held: Remote): FakeStatus | undefined => held.status() as FakeStatus | undefined;
const link = (sandboxUrl: string, scopes: DeviceScopes) => ({ sandboxUrl, scopes, log: () => undefined });
const input = (uplinkToken = "token-1") => ({ device: "rog", uplinkToken, mediaKey: KEY });

const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        // allow(silent-catch): ESRCH is the answer: no such process
        return false;
    }
};

test.skipIf(!posix.runs)(posix.title("remoteStart writes the link's uplink 0600, starts remoted and answers once that uplink is up"), async () => {
    const { remote: held, logged, audited } = harness();
    const answer = await held.start(link(ALPHA, grant({ remoteView: "on", remoteTerminal: "on" })), input());
    expect(answer).toEqual({
        version: "0.0.0",
        allow: { view: true, control: false, terminal: true },
        monitors: [{ id: "1", name: "one", x: 0, y: 0, width: 1920, height: 1080, scale: 1.5, primary: true }],
        environments: ["native"],
    });
    expect(await config()).toEqual({
        paused: false,
        notBefore: 0,
        uplinks: [
            {
                id: ALPHA,
                url: "http://127.0.0.1:9/alpha.example.dev",
                device: "rog",
                uplinkToken: "token-1",
                mediaKey: KEY,
                allow: { view: true, control: false, terminal: true },
                generation: 1,
            },
        ],
    });
    expect((await stat(join(dir, "remoted.json"))).mode & 0o777).toBe(0o600);
    // The status `remote status` reads, kept beside the config as it arrives.
    const pid = held.status()?.pid;
    await waitFor(async () => expect((await readRemotedStatus(join(dir, "remoted-status.json")))?.pid).toBe(pid), SETTLES);
    // stderr is a pipe of its own, so its line may come after the status that answered.
    await waitFor(() => expect(logged).toContain("remoted: 2026-11-20T13:00:00Z INFO remoted: fake listening"), SETTLES);
    expect(audited).toEqual([
        { tool: "remoteStart", ok: true, detail: "alpha.example.dev as device rog, view on, control off, terminals on: remoted 0.0.0 up" },
    ]);
    expect(JSON.stringify([logged, audited])).not.toContain("token-1");
    expect(JSON.stringify([logged, audited])).not.toContain(KEY);

    // Started again for the same link, the uplink takes the new token under the next generation, in the same remoted,
    // and the sandbox's STUN servers when it sends them (none were sent above, and the uplink held none).
    await held.start(link(ALPHA, grant({ remoteView: "on" })), { ...input("token-2"), iceServers: ["stun:stun.example.test:3478"] });
    expect((await config())?.uplinks.map(({ uplinkToken, generation, iceServers }) => ({ uplinkToken, generation, iceServers }))).toEqual([
        { uplinkToken: "token-2", generation: 2, iceServers: ["stun:stun.example.test:3478"] },
    ]);
    expect(held.status()?.pid).toBe(pid);
});

test.skipIf(!posix.runs)(
    posix.title("a switch turned on or off reaches remoted's config without restarting it; all three off drops the uplink and stops it"),
    async () => {
        const { remote: held, audited } = harness();
        await held.start(link(ALPHA, grant({ remoteTerminal: "on" })), input());
        const pid = held.status()?.pid ?? 0;

        await held.scopesChanged(ALPHA, grant({ remoteTerminal: "on", remoteControl: "on", remoteView: "on" }));
        await waitFor(() => expect(fakeStatus(held)?.allow).toEqual([{ view: true, control: true, terminal: true }]), SETTLES);
        expect(held.status()?.pid).toBe(pid);

        await held.scopesChanged(ALPHA, grant({}));
        expect((await config())?.uplinks).toEqual([]);
        await waitFor(() => expect(alive(pid)).toBe(false), SETTLES);
        expect(held.status()).toBeUndefined();
        await waitFor(() => expect(existsSync(join(dir, "remoted-status.json"))).toBe(false), SETTLES);
        expect(audited.filter((entry) => entry.tool === "remoteScopes").map((entry) => entry.detail)).toEqual([
            "alpha.example.dev: uplink now view on, control on, terminals on",
            "alpha.example.dev: uplink dropped, every people switch is off",
        ]);
    },
);

test.skipIf(!posix.runs)(
    posix.title("one remoted holds every link's uplink, and remoteStop stops it only once the last one is dropped"),
    async () => {
        const { remote: held } = harness();
        await held.start(link(ALPHA, grant({ remoteView: "on" })), input());
        await held.start(link(BETA, grant({ remoteTerminal: "on" })), input());
        const pid = held.status()?.pid ?? 0;
        expect(fakeStatus(held)?.uplinks.map((uplink) => [uplink.id, uplink.state])).toEqual([
            [ALPHA, "up"],
            [BETA, "up"],
        ]);

        await held.stop({ sandboxUrl: ALPHA, log: () => undefined });
        expect((await config())?.uplinks.map((uplink) => uplink.id)).toEqual([BETA]);
        expect(alive(pid)).toBe(true);

        await held.stop({ sandboxUrl: BETA, log: () => undefined });
        await waitFor(() => expect(alive(pid)).toBe(false), SETTLES);
        expect((await config())?.uplinks).toEqual([]);
    },
);

test.skipIf(!posix.runs)(posix.title("a remoted that exits by itself is started again, and says how it ended"), async () => {
    const { remote: held, logged } = harness();
    await held.start(link(ALPHA, grant({ remoteView: "on" })), input());
    const first = held.status()?.pid ?? 0;

    await writeFile(join(dir, "crash"), "");
    // Between the two runs there is no status at all, which is not the new run either.
    await waitFor(() => {
        expect(held.status()?.pid).toEqual(expect.any(Number));
        expect(held.status()?.pid).not.toBe(first);
    }, SETTLES);
    expect(logged).toContain(
        "remoted: exited with code 3; its last line: 2026-11-20T13:00:01Z ERROR remoted: told to crash; starting it again in 1s",
    );
    // The uplink is the same one, served by the new process.
    expect(held.status()?.uplinks.map((uplink) => uplink.state)).toEqual(["up"]);
});

test.skipIf(!posix.runs)(posix.title("an uplink that does not come up is answered with remoted's own words for it, and left dialling"), async () => {
    const { remote: held, audited } = harness({ upTimeoutMs: 1_500 });
    const started = held.start(link("https://unreachable.example.dev", grant({ remoteView: "on" })), input());
    await expect(started).rejects.toMatchObject({
        code: "GATEWAY_TIMEOUT",
        message: "intentic-remoted on this computer did not connect to the sandbox within 1.5 s (it is down: connection refused). It keeps trying.",
    });
    expect((await config())?.uplinks.map((uplink) => uplink.id)).toEqual(["https://unreachable.example.dev"]);
    expect(held.status()?.uplinks.map((uplink) => uplink.state)).toEqual(["down"]);
    expect(audited.map((entry) => entry.ok)).toEqual([false]);
});

test.skipIf(!posix.runs)(posix.title("a remoted that cannot be had is refused with why, and nothing is written"), async () => {
    const { remote: held } = harness({
        binary: async (said) => await resolveRemoted("1.400.0", { ...realRemotedIo(said), env: { [REMOTED_BIN_ENV]: join(dir, "nowhere") } }),
    });
    await expect(held.start(link(ALPHA, grant({ remoteView: "on" })), input())).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: `Refused: people cannot reach this computer: ${REMOTED_BIN_ENV} names ${join(dir, "nowhere")}, which does not exist on this computer.`,
    });
    expect(await config()).toBeUndefined();
});

test.skipIf(!posix.runs)(
    posix.title("the next agent takes up the uplinks of links that still exist and still allow something, and drops the rest"),
    async () => {
        const uplink = (id: string) => ({
            id,
            url: id,
            device: "rog",
            uplinkToken: "t",
            mediaKey: KEY,
            allow: { view: true, control: false, terminal: false },
            generation: 4,
        });
        const left: RemotedConfig = { paused: false, notBefore: 7, uplinks: [uplink(ALPHA), uplink(BETA), uplink("https://gone.example.dev")] };
        await writeFile(join(dir, "remoted.json"), JSON.stringify(left));
        const links: HostLink[] = [
            { sandboxUrl: ALPHA, id: "rog", token: "iht", scopes: grant({ remoteControl: "on" }) },
            { sandboxUrl: BETA, id: "rog", token: "iht", scopes: grant({}) },
        ];
        const { remote: held } = harness();
        await held.keepLinks(links);
        expect(await config()).toEqual({ ...left, uplinks: [{ ...uplink(ALPHA), allow: { view: false, control: true, terminal: false } }] });
        await waitFor(() => expect(held.status()?.uplinks.map((one) => [one.id, one.state])).toEqual([[ALPHA, "up"]]), SETTLES);

        // A link removed later takes its uplink with it, and remoted with the last.
        const pid = held.status()?.pid ?? 0;
        await held.keepLinks([]);
        expect((await config())?.uplinks).toEqual([]);
        await waitFor(() => expect(alive(pid)).toBe(false), SETTLES);
    },
);

test.skipIf(!posix.runs)(
    posix.title("people coming and going are audited and put on the notice, and the person's pause reaches remoted"),
    async () => {
        const { remote: held, audited, shown, setPaused } = harness();
        await held.start(link(ALPHA, grant({ remoteControl: "on", remoteView: "on" })), input());

        await writeFile(join(dir, "people.json"), JSON.stringify([{ uplink: ALPHA, kind: "control", session: "v-1", readOnly: false, since: 1 }]));
        await waitFor(() => expect(shown.at(-1)).toEqual([{ kind: "control", sandboxUrl: ALPHA }]), SETTLES);
        setPaused(true);
        await held.pausedChanged();
        await waitFor(() => expect(fakeStatus(held)?.paused).toBe(true), SETTLES);

        await rm(join(dir, "people.json"));
        await waitFor(() => expect(shown.at(-1)).toEqual([]), SETTLES);
        expect(audited.filter((entry) => entry.tool === "remote-person").map((entry) => entry.detail)).toEqual([
            "a person's control session v-1 opened, from alpha.example.dev",
            "a person's control session v-1 ended, from alpha.example.dev",
        ]);
        expect(JSON.parse(await readFile(join(dir, "remoted.json"), "utf8"))).toMatchObject({ paused: true });
    },
);
