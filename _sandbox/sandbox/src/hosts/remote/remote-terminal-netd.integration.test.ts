import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseJsonWith } from "@intentic/base/json";
import { repoRoot } from "@intentic/constants/node";
import type { TerminalClientMessage, TerminalServerMessage } from "@intentic/sandbox-contract/browser-wire";
import type { RemoteAllow, RemoteStartResult } from "@intentic/sandbox-contract/schemas/device-remote";
import type { AuditEvent } from "@intentic/sandbox-contract/schemas/audit";
import { requires } from "@intentic/testing/requires";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { mintMediaToken } from "../../browser/media/media-token.js";
import { connectNetd, type DeviceUplinksReport, type NetdLink } from "../../netd/netd-link.js";
import { netdUplinks } from "./netd-uplinks.js";
import { createRemoteAccess, type RemoteLink } from "./remote-access.js";
import { fileRemoteKeys } from "./remote-keys.js";
import { remotedControl, socketOf } from "./remoted-control.js";

/* A PERSON'S TERMINAL ON A CONNECTED COMPUTER, END TO END ON THE REAL BINARIES (2026-11-20): the real netd, the real
   intentic-remoted with a real shell on a real pseudo-terminal, and this file playing the rest. First as the daemon's
   wire speaks it, by hand: the device registered over netd's control socket, remoted started with a config naming that
   netd, a terminal made through the device's Unix socket and a viewer's WebSocket opened at
   /system/device-terminal/<device>/<session> with a castd-format token; typed into, resized, its token refreshed in band
   (a socket left without one is closed 4002), and the device withdrawn under it. Then the same through the daemon's own
   remote-access.ts, with a stand-in machine agent whose `remoteStart` writes remoted's config and waits for its uplink,
   as device/remote/remote.ts does. It also measures keystroke-to-echo over the whole path (remoted's README, "Measured").

   Both binaries are debug builds by default; INTENTIC_NETD_BINARY and INTENTIC_REMOTED_BINARY name others, remoted's
   still a debug one: the 4002 check shortens its token grace through INTENTIC_REMOTED_TOKEN_GRACE_MS, which a release
   build ignores. CI's netd-check job builds both and runs this file as its `netd` lane (ci.yml). */

const ROOT = repoRoot(import.meta.url);
const NETD = process.env["INTENTIC_NETD_BINARY"] ?? join(ROOT, "_sandbox/netd/target/debug/intentic-netd");
const REMOTED = process.env["INTENTIC_REMOTED_BINARY"] ?? join(ROOT, "_devices/remoted/target/debug/intentic-remoted");
const built = requires(
    existsSync(NETD) && existsSync(REMOTED),
    `netd's and intentic-remoted's builds at ${NETD} and ${REMOTED} (cargo build in _sandbox/netd and _devices/remoted)`,
    { lane: "netd" },
);

const PATIENCE_MS = 10_000;
const TERMINALS_ONLY: RemoteAllow = { view: false, control: false, terminal: true };

const sleep = async (ms: number): Promise<void> => await new Promise((resolve) => setTimeout(resolve, ms));

const freePort = async (): Promise<number> =>
    await new Promise((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            server.close(() => resolve(z.object({ port: z.number() }).parse(address).port));
        });
    });

const accepts = async (port: number): Promise<boolean> =>
    await new Promise((resolve) => {
        const socket = connect(port, "127.0.0.1");
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => resolve(false));
    });

const waitFor = async (what: string, ready: () => boolean | Promise<boolean>, ms: number = PATIENCE_MS): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!(await ready())) {
        if (Date.now() > deadline) {
            throw new Error(`waited ${ms} ms for ${what}`);
        }
        await sleep(20);
    }
};

// --- remoted, as the machine agent runs it -------------------------------------------------------------------------

interface UplinkConfig {
    readonly id: string;
    readonly url: string;
    readonly device: string;
    readonly uplinkToken: string;
    readonly mediaKey: string;
    readonly allow: RemoteAllow;
    readonly generation: number;
}

// remoted's status line (its status.rs), as far as this file reads it.
const StatusSchema = z.object({
    type: z.literal("status"),
    version: z.string(),
    uplinks: z.array(z.object({ id: z.string(), state: z.string(), generation: z.number().optional() })),
    environments: z.array(z.string()),
});
type RemotedStatus = z.infer<typeof StatusSchema>;

// What a terminal socket says as text (browser-wire's TerminalServerMessage).
const ServerMessageSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("grid"), cols: z.number(), rows: z.number() }),
    z.object({ type: z.literal("exit"), code: z.number(), reason: z.string().optional() }),
    z.object({ type: z.literal("pong") }),
    z.object({ type: z.literal("deflate") }),
]);
type ServerMessage = z.infer<typeof ServerMessageSchema> & Pick<TerminalServerMessage, "type">;
const FrameSchema = z.union([z.string(), z.instanceof(ArrayBuffer)]);

// remoted.json written whole by rename, as the agent writes it; remoted re-reads it within 500 ms.
const writeConfig = async (path: string, uplinks: readonly UplinkConfig[]): Promise<void> => {
    await writeFile(`${path}.tmp`, JSON.stringify({ paused: false, notBefore: 0, uplinks }), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
};

// `intentic-remoted run --config <file> --parent-stdin`, its status lines kept; the token grace shortened (a debug
// build's knob) so a socket left without a fresh token is closed within one of its 15 s checks.
const runRemoted = (config: string) => {
    let last: RemotedStatus | undefined;
    const child = spawn(REMOTED, ["run", "--config", config, "--parent-stdin"], {
        stdio: ["pipe", "pipe", "inherit"],
        env: { ...process.env, RUST_LOG: "warn", INTENTIC_REMOTED_TOKEN_GRACE_MS: "0" },
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
        last = parseJsonWith(line, StatusSchema) ?? last;
    });
    const uplink = (id: string) => last?.uplinks.find((held) => held.id === id);
    return {
        child,
        status: () => last,
        // remoted's word that this uplink is `state` at this generation or a later one.
        until: async (id: string, state: string, generation: number): Promise<RemotedStatus> => {
            let reached: RemotedStatus | undefined;
            await waitFor(`remoted's uplink ${id} ${state}`, () => {
                reached = uplink(id)?.state === state && (uplink(id)?.generation ?? 0) >= generation ? last : undefined;
                return reached !== undefined;
            });
            return z.custom<RemotedStatus>(() => reached !== undefined).parse(reached);
        },
    };
};

// --- a person's viewer --------------------------------------------------------------------------------------------

interface Viewer {
    readonly socket: WebSocket;
    // Every pane byte so far, decoded.
    readonly screen: () => string;
    readonly said: () => readonly ServerMessage[];
    readonly send: (message: TerminalClientMessage) => void;
    readonly closed: Promise<{ readonly code: number; readonly reason: string }>;
    readonly isClosed: () => boolean;
    // Resolves once `seen` holds, checked on every message.
    readonly until: (what: string, seen: () => boolean, ms?: number) => Promise<void>;
}

const openViewer = async (url: string): Promise<Viewer> => {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    const decoder = new TextDecoder();
    let screen = "";
    const said: ServerMessage[] = [];
    const listeners = new Set<() => void>();
    let isClosed = false;
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        socket.addEventListener("close", (event) => {
            isClosed = true;
            for (const listener of listeners) {
                listener();
            }
            resolve({ code: event.code, reason: event.reason });
        });
    });
    socket.addEventListener("message", (event) => {
        const frame = FrameSchema.parse(event.data);
        if (frame instanceof ArrayBuffer) {
            screen += decoder.decode(new Uint8Array(frame), { stream: true });
        } else {
            said.push(ServerMessageSchema.parse(JSON.parse(frame)));
        }
        for (const listener of listeners) {
            listener();
        }
    });
    await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve());
        socket.addEventListener("error", () => reject(new Error(`the viewer's socket did not open: ${url.replace(/token=[^&]+/u, "token=…")}`)));
    });
    return {
        socket,
        screen: () => screen,
        said: () => said,
        send: (message) => socket.send(JSON.stringify(message)),
        closed,
        isClosed: () => isClosed,
        until: async (what, seen, ms = PATIENCE_MS) =>
            await new Promise<void>((resolve, reject) => {
                const check = (): void => {
                    if (seen()) {
                        finish();
                        resolve();
                    } else if (isClosed) {
                        finish();
                        reject(new Error(`the socket closed while waiting for ${what}; the pane said: ${JSON.stringify(screen.slice(-400))}`));
                    }
                };
                const timer = setTimeout(() => {
                    finish();
                    reject(new Error(`waited ${ms} ms for ${what}; the pane said: ${JSON.stringify(screen.slice(-400))}`));
                }, ms);
                const finish = (): void => {
                    clearTimeout(timer);
                    listeners.delete(check);
                };
                listeners.add(check);
                check();
            }),
    };
};

// Types a command whose output only running it prints (the sum is never typed), and waits for that output.
const runs = async (viewer: Viewer, ...others: readonly Viewer[]): Promise<void> => {
    const n = Math.floor(Math.random() * 1_000_000);
    viewer.send({ type: "input", data: `echo e2e-$((1000000+${n}))\r` });
    for (const one of [viewer, ...others]) {
        await one.until(`the output e2e-${1_000_000 + n}`, () => one.screen().includes(`e2e-${1_000_000 + n}`));
    }
};

// Keystroke to its echo, one key at a time, then the line cleared (Ctrl-U).
const echoLatency = async (viewer: Viewer, keys: number): Promise<number[]> => {
    const took: number[] = [];
    for (let index = 0; index < keys; index++) {
        const key = String.fromCodePoint(0x61 + (index % 26));
        const mark = viewer.screen().length;
        const sent = performance.now();
        viewer.send({ type: "input", data: key });
        await viewer.until(`the echo of ${key}`, () => viewer.screen().slice(mark).includes(key));
        took.push(performance.now() - sent);
    }
    viewer.send({ type: "input", data: "\u0015" });
    return took;
};

const quantile = (values: readonly number[], q: number): number => {
    const sorted = values.toSorted((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN;
};

// --- the sandbox's side ---------------------------------------------------------------------------------------------

let runDir: string;
let netd: ChildProcess | undefined;
let link: NetdLink | undefined;
let remoted: ReturnType<typeof runRemoted> | undefined;
let daemonPort: number;
let reported: DeviceUplinksReport | undefined;
let hearing: ((report: DeviceUplinksReport) => void) | undefined;

const connectedIn = (device: string): boolean => reported?.uplinks.some((uplink) => uplink.device === device && uplink.connected) === true;
const registeredIn = (device: string): boolean => reported?.uplinks.some((uplink) => uplink.device === device) === true;

beforeAll(async () => {
    if (!built.runs) {
        return;
    }
    runDir = await mkdtemp(join(tmpdir(), "intentic-remote-e2e-"));
    netd = spawn(NETD, ["--run-dir", runDir, "--", "sleep", "3600"], { stdio: "ignore", env: { ...process.env, NETD_LOG: "warn" } });
    const deadline = Date.now() + PATIENCE_MS;
    const dial = async (): Promise<NetdLink> => {
        try {
            return await connectNetd({
                path: join(runDir, "netd.sock"),
                answer: () => Promise.reject(new Error("not asked here")),
                onTunnel: () => undefined,
                onDeviceUplinks: (report) => {
                    reported = report;
                    hearing?.(report);
                },
                onClose: () => undefined,
                onFault: () => undefined,
            });
        } catch (error) {
            if (Date.now() > deadline) {
                throw new Error("netd never took a connection on its control socket", { cause: error });
            }
            await sleep(20);
            return await dial();
        }
    };
    link = await dial();
    daemonPort = await freePort();
    link.tell({ kind: "listen", config: { daemon: { host: "127.0.0.1", port: daemonPort }, frameAncestors: [], previewProbePath: "/__probe" } });
    link.tell({ kind: "hello", build: "test", pid: process.pid });
    await waitFor("netd's daemon listener", async () => await accepts(daemonPort));
    await waitFor("netd's first device report", () => reported !== undefined);
    // The agent writes the config before it starts remoted, which reads it at once.
    await writeConfig(join(runDir, "remoted.json"), []);
    remoted = runRemoted(join(runDir, "remoted.json"));
});

afterAll(async () => {
    remoted?.child.stdin?.end();
    remoted?.child.kill("SIGKILL");
    link?.close();
    netd?.kill("SIGKILL");
    if (runDir !== undefined) {
        await rm(runDir, { recursive: true, force: true });
    }
});

const base = (): string => `http://127.0.0.1:${daemonPort}`;
const viewerUrl = (path: string, token: string, query = "cols=80&rows=24"): string => `ws://127.0.0.1:${daemonPort}${path}?token=${token}&${query}`;

test.skipIf(!built.runs)(
    built.title("by the wire: a device registered with netd, its remoted dialled in, a terminal typed into, resized, kept by a fresh token and withdrawn"),
    async () => {
        const device = "e2e-wire";
        const uplinkToken = randomBytes(32).toString("base64url");
        const key = randomBytes(32);
        link?.tell({ kind: "deviceUplink", device, tokenSha256: createHash("sha256").update(uplinkToken, "utf8").digest("hex") });
        await waitFor("netd's registration of the device", () => registeredIn(device));
        const config = join(runDir, "remoted.json");
        await writeConfig(config, [{ id: "http://wire.test", url: base(), device, uplinkToken, mediaKey: key.toString("base64url"), allow: TERMINALS_ONLY, generation: 1 }]);
        const dialled = performance.now();
        await waitFor("the device's uplink, as netd reports it", () => connectedIn(device));
        const upMs = performance.now() - dialled;

        // The daemon's call, down the device's own socket as Node makes it.
        const control = remotedControl(socketOf(device, join(runDir, "devices")));
        const session = "t-wire";
        const made = await control.openTerminal({ session, cols: 80, rows: 24 });
        expect(made).toMatchObject({ session, environment: "native", viewers: 0 });
        expect(await control.info()).toMatchObject({ allow: TERMINALS_ONLY, environments: ["native"] });

        const now = Date.now();
        const token = (readOnly: boolean, expiresAt: number): string => mintMediaToken(key, { session: `terminal/${session}`, expiresAt, readOnly, issuedAt: Date.now() });
        const path = `/system/device-terminal/${device}/${session}`;
        const person = await openViewer(viewerUrl(path, token(false, now + 600_000)));
        // Two watchers whose tokens lapse at once: one is handed a fresh token in band, the other is not.
        const kept = await openViewer(viewerUrl(path, token(true, now + 1_000)));
        const lapsed = await openViewer(viewerUrl(path, token(true, now + 1_000)));
        kept.send({ type: "token", token: token(true, Date.now() + 600_000) });
        // A token for another session, or with other access, moves nothing.
        lapsed.send({ type: "token", token: token(false, Date.now() + 600_000) });

        await runs(person, kept);
        const typed = performance.now();
        await runs(person);
        const commandMs = performance.now() - typed;

        person.send({ type: "resize", cols: 100, rows: 30 });
        await person.until("the grid at 100x30", () => person.said().some((message) => message.type === "grid" && message.cols === 100 && message.rows === 30));
        const mark = person.screen().length;
        person.send({ type: "input", data: "stty size\r" });
        await person.until("stty's 30 100", () => person.screen().slice(mark).includes("30 100"));

        const keystrokes = await echoLatency(person, 20);

        // The lapsed watcher is closed for its token at remoted's next look; the refreshed one stays and still sees.
        expect(await lapsed.closed).toEqual({ code: 4002, reason: "token expired" });
        expect(kept.isClosed()).toBe(false);
        await runs(person, kept);

        process.stderr.write(
            `${JSON.stringify({
                measured: "browser WebSocket → netd → yamux uplink → remoted → pty (bash) and back, on loopback",
                uplinkUpMs: Math.round(upMs),
                commandRoundTripMs: Math.round(commandMs),
                keystrokeEchoMs: { median: +quantile(keystrokes, 0.5).toFixed(2), p90: +quantile(keystrokes, 0.9).toFixed(2), worst: +Math.max(...keystrokes).toFixed(2) },
            })}\n`,
        );

        // Withdrawn: netd closes the uplink (4003), every viewer's socket ends, the device's socket goes, remoted waits.
        link?.tell({ kind: "deviceWithdraw", device });
        await Promise.all([person.closed, kept.closed]);
        await waitFor("netd forgetting the device", () => !registeredIn(device));
        expect(existsSync(socketOf(device, join(runDir, "devices")))).toBe(false);
        await remoted?.until("http://wire.test", "withdrawn", 1);
    },
    60_000,
);

test.skipIf(!built.runs)(
    built.title("through remote-access.ts: the first open starts remoted through the agent, and a terminal opens, refreshes, lists and closes"),
    async () => {
        const device = "e2e-pc";
        const config = join(runDir, "remoted.json");
        let generation = 1;
        const starts: string[] = [];
        // The machine agent as device/remote/remote.ts is: the link's uplink written into remoted.json a generation on,
        // and the answer once remoted says that uplink is up.
        const agent: RemoteLink = {
            refusal: () => undefined,
            online: () => true,
            start: async (_device, input): Promise<RemoteStartResult> => {
                starts.push(input.device);
                generation += 1;
                const { device: uplinkDevice, uplinkToken, mediaKey } = input;
                await writeConfig(config, [{ id: "http://node.test", url: base(), device: uplinkDevice, uplinkToken, mediaKey, allow: TERMINALS_ONLY, generation }]);
                const status = await (remoted ?? { until: async () => await Promise.reject(new Error("no remoted")) }).until("http://node.test", "up", generation);
                return { version: status.version, allow: TERMINALS_ONLY, monitors: [], environments: [...status.environments] };
            },
            cardAllows: async () => TERMINALS_ONLY,
            environments: () => ({ own: "native", ownConnections: new Set() }),
        };
        const audit: AuditEvent[] = [];
        const remote = createRemoteAccess({
            link: agent,
            keys: fileRemoteKeys(join(runDir, "keys")),
            control: (uplinkId) => remotedControl(socketOf(uplinkId, join(runDir, "devices"))),
            iceServers: async () => [],
            audit: (event) => audit.push(event),
            logger: { info: () => undefined, warn: () => undefined },
        });
        hearing = (report) => remote.heard(report);
        remote.useNetd(netdUplinks((message) => link?.tell(message)));
        // As a daemon that just started: netd tells it where the uplinks stand after its hello.
        link?.tell({ kind: "hello", build: "test", pid: process.pid });
        const owner = { actor: { kind: "member", email: "owner@example.com", role: "owner" }, full: true } as const;
        try {
            await waitFor("the remote access hearing netd", async () => (await remote.status(device, owner)).available);
            const opened = await remote.openTerminal({ device, cols: 80, rows: 24 }, owner);
            expect(starts).toEqual([device]);
            expect(opened.path).toBe(`/system/device-terminal/${device}/${opened.session}`);
            const person = await openViewer(viewerUrl(opened.path, opened.token));
            await runs(person);
            person.send({ type: "token", token: (await remote.refresh(device, opened.session, owner)).token });
            await runs(person);

            const status = await remote.status(device, owner);
            expect(status).toMatchObject({ available: true, allow: TERMINALS_ONLY, environments: ["native"], monitors: [] });
            expect(status.terminals).toEqual([expect.objectContaining({ session: opened.session, environment: "native", viewers: 1 })]);
            // A second open reuses the running remoted.
            const second = await remote.openTerminal({ device, cols: 80, rows: 24 }, owner);
            expect(starts).toEqual([device]);

            await remote.closeTerminal(device, opened.session, owner);
            await person.until("the terminal's exit", () => person.said().some((message) => message.type === "exit"));
            await person.closed;
            const gone = await remote.attachTerminal(device, opened.session, owner).catch((error: unknown) => error);
            expect(gone instanceof ORPCError ? gone.code : gone).toBe("NOT_FOUND");
            expect((await remote.attachTerminal(device, second.session, owner)).session).toBe(second.session);
            expect(audit.map((event) => event.action)).toEqual([
                "device.remote.terminal.open",
                "device.remote.terminal.open",
                "device.remote.terminal.close",
                "device.remote.terminal.attach",
            ]);
        } finally {
            hearing = undefined;
            remote.stop();
        }
    },
    60_000,
);
