import type { HostSummary, DeviceFlowLine, DeviceReport, DeviceSandboxFlow } from "@intentic/sandbox-contract";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { afterEach, expect, test, vi } from "vitest";
import type { Services } from "../composition.js";
import type { SyncEnrollmentRow } from "../platform/sync.js";
import { devices, manageDeviceSandbox, mergeDevices, type PullResult, reportFrom, sandboxesFromTool } from "./device-reports.js";

// The push half, recorded rather than fed to a live /events feed: subscribing for real would start the runtime
// sampler (tmux, procfs) for a fact this file states in one line.
const { published } = vi.hoisted(() => ({ published: [] as string[] }));
vi.mock("../system/runtime-watch.js", () => ({ publishRuntimeChange: (...domains: string[]) => published.push(...domains) }));

const report = (hostname: string, overrides: Partial<DeviceReport> = {}): DeviceReport => ({
    hostname,
    os: "linux",
    sandboxes: [],
    pairings: [],
    ports: [],
    agent: { running: true, installed: "0.1.0" },
    capturedAt: 1_700_000_000_000,
    ...overrides,
});

// platform is always set on a host capability; connected-machine facts appear only once it has answered.
const host = (id: string, overrides: Partial<HostSummary> = {}): HostSummary => ({
    id,
    platform: "linux",
    online: true,
    ...overrides,
});

// One desktop-sync enrollment fixture: a machine name and which sync mode it holds.
const enrolled = (machine: string, mode: "sync" | "mirror" = "sync"): SyncEnrollmentRow => ({ machine, mode });

// Status envelope the agent prints; the report rides in its `sync` field.
const statusEnvelope = (machine: DeviceReport): string =>
    JSON.stringify({ version: "1.0.0", summary: "syncing", device: { links: [] }, sync: machine });

test("finds the report inside run_command's prose answer", () => {
    const answer = `Exit code 0 (success).\n--- stdout ---\n${statusEnvelope(report("laptop"))}`;
    expect(reportFrom(answer)?.hostname).toBe("laptop");
});

test("survives a banner before it and a warning after it", () => {
    const answer = [
        "Exit code 0 (success).",
        "--- stdout ---",
        "Welcome to your shell!",
        statusEnvelope(report("laptop")),
        "--- stderr ---",
        "warning: something unrelated",
    ].join("\n");
    expect(reportFrom(answer)?.hostname).toBe("laptop");
});

test("finds nothing when the command printed no report", () => {
    expect(reportFrom("Exit code 127 (failed).\n--- stderr ---\nintentic-machine: command not found")).toBeUndefined();
    expect(reportFrom(`--- stdout ---\n{"hostname":"laptop"}`)).toBeUndefined();
    expect(reportFrom(`--- stdout ---\n{ not json at all }`)).toBeUndefined();
});

test("keeps looking past a line that only looked like JSON", () => {
    const answer = `--- stdout ---\n${statusEnvelope(report("laptop"))}\n{ tail garbage }`;
    expect(reportFrom(answer)?.hostname).toBe("laptop");
});

test("reads the fleet the machine's own tool answered", () => {
    const fleet = [{ slug: "work", container: "intentic-sandbox-work", running: true, image: "img" }];
    expect(sandboxesFromTool(JSON.stringify(fleet, undefined, 2), false)).toEqual(fleet);
});

test("a container's resources ride through the fleet reading untouched", () => {
    const fleet = [
        {
            slug: "work",
            container: "intentic-sandbox-work",
            running: true,
            image: "img",
            resources: { memoryBytes: 12 * 1024 ** 3, cpus: 4, privileged: true, gpu: false, hostRuntime: ["--privileged"], overlayRuntime: [] },
        },
    ];
    expect(sandboxesFromTool(JSON.stringify(fleet), false)).toEqual(fleet);
});

test("an agent without the tool, or an answer that is not the fleet, contributes no sandboxes", () => {
    expect(sandboxesFromTool(`This device has no tool called "list_sandboxes".`, true)).toEqual([]);
    expect(sandboxesFromTool("not json", false)).toEqual([]);
    expect(sandboxesFromTool(`{"slug":"work"}`, false)).toEqual([]);
});

test("keeps an enrolled machine that has never reported, and says why it is empty", () => {
    const merged = mergeDevices([enrolled("laptop")], [], []);
    expect(merged).toEqual([{ key: "laptop", label: "laptop", sync: enrolled("laptop"), gap: "unreported" }]);
});

test("says what a connected device is even when it reported nothing", () => {
    const facts = { os: "Windows 11 Pro (build 10.0.26100)", arch: "x64", shell: "PowerShell 7", home: "C:\\Users\\ada", roots: ["C:\\Users\\ada"] };
    const merged = mergeDevices(
        [],
        [],
        [{ host: host("my-pc", { platform: "windows", facts, version: "0.5.1", lastSeen: 1_700_000_000_000 }), result: { gap: "no-agent" } }],
    );
    expect(merged[0]).toEqual({
        key: "my-pc",
        label: "my-pc",
        hostId: "my-pc",
        online: true,
        platform: "windows",
        facts,
        agentVersion: "0.5.1",
        lastSeen: 1_700_000_000_000,
        gap: "no-agent",
    });
});

// The report's os field is `os.platform()`'s spelling (win32/darwin), mapped here to platform names.
test("reads a sync-only machine's platform off its report", () => {
    const merged = mergeDevices(
        [enrolled("laptop"), enrolled("mac")],
        [
            { machine: "laptop", report: report("laptop-box", { os: "win32" }) },
            { machine: "mac", report: report("mac-box", { os: "darwin" }) },
        ],
        [],
    );
    expect(merged.map((row) => row.platform)).toEqual(["windows", "macos"]);
});

// Rows join on hostname, not on the enrollment name or capability id, which can each differ.
test("folds a sync enrollment and a host capability into one row when the hostname agrees", () => {
    const pulled: PullResult = {
        report: report("blackbox", { sandboxes: [{ slug: "work", container: "intentic-sandbox-work", running: true, image: "img" }] }),
    };
    const merged = mergeDevices([enrolled("laptop")], [{ machine: "laptop", report: report("blackbox") }], [{ host: host("my-pc"), result: pulled }]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ key: "blackbox", label: "laptop", sync: enrolled("laptop"), hostId: "my-pc", online: true });
    expect(merged[0]?.report?.sandboxes).toHaveLength(1);
});

test("joins an offline device to the machine it is already syncing", () => {
    const merged = mergeDevices(
        [enrolled("radarsu-rog")],
        [{ machine: "radarsu-rog", report: report("radarsu-rog") }],
        [{ host: host("radarsu-rog", { online: false, platform: "linux" }), result: { gap: "offline" } }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ key: "radarsu-rog", label: "radarsu-rog", hostId: "radarsu-rog", online: false, platform: "linux" });
    expect(merged[0]?.report?.hostname).toBe("radarsu-rog");
    expect(merged[0]?.gap).toBeUndefined();
});

// ── environments that share a name ───────────────────────────────────────────
// WSL hands a distro the Windows machine's own hostname, and the distro is usually named after the machine too, so
// both of merge's keys collide between two environments that share nothing else: separate filesystems, separate
// agents, separate containers. Folding them would put one machine's buttons on the other's row.

test("keeps a Windows card off the Linux row that shares its name", () => {
    const merged = mergeDevices(
        [enrolled("radarsu-rog")],
        [{ machine: "radarsu-rog", report: report("radarsu-rog") }],
        [{ host: host("radarsu-rog", { online: false, platform: "windows" }), result: { gap: "offline" } }],
    );
    expect(merged).toHaveLength(2);
    expect(merged.map((row) => row.platform)).toEqual(["linux", "windows"]);
    // The sync half stays on the machine that actually reported it, rather than riding the Windows card.
    expect(merged.find((row) => row.sync !== undefined)?.hostId).toBeUndefined();
});

test("keeps a WSL distro apart from the Windows install hosting it", () => {
    const distro = report("radarsu-rog", { wsl: { distro: "Arch" } });
    const merged = mergeDevices(
        [enrolled("radarsu-rog")],
        [{ machine: "radarsu-rog", report: distro }],
        [{ host: host("radarsu-rog", { platform: "windows" }), result: { report: report("radarsu-rog", { os: "win32" }) } }],
    );
    expect(merged).toHaveLength(2);
    expect(merged.map((row) => row.platform)).toEqual(["linux", "windows"]);
});

test("keeps two WSL distros on one machine apart", () => {
    const merged = mergeDevices(
        [enrolled("radarsu-rog")],
        [{ machine: "radarsu-rog", report: report("radarsu-rog", { wsl: { distro: "Arch" } }) }],
        [{ host: host("radarsu-rog-ubuntu"), result: { report: report("radarsu-rog", { wsl: { distro: "Ubuntu-22.04" } }) } }],
    );
    expect(merged).toHaveLength(2);
    expect(merged.map((row) => row.hostId)).toEqual([undefined, "radarsu-rog-ubuntu"]);
});

test("still folds one distro seen through both doors", () => {
    const distro = { distro: "Arch" };
    const merged = mergeDevices(
        [enrolled("radarsu-rog")],
        [{ machine: "radarsu-rog", report: report("radarsu-rog", { wsl: distro }) }],
        [{ host: host("radarsu-rog-wsl-arch"), result: { report: report("radarsu-rog", { wsl: distro }) } }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ hostId: "radarsu-rog-wsl-arch", sync: enrolled("radarsu-rog") });
});

// An agent too old to report `wsl` must keep folding exactly as it did before the field existed, rather than
// splitting every row that has only ever been described by one of the two doors.
test("folds as it always did when neither side mentions WSL", () => {
    const merged = mergeDevices(
        [enrolled("radarsu-rog")],
        [{ machine: "radarsu-rog", report: report("radarsu-rog") }],
        [{ host: host("radarsu-rog-wsl-arch"), result: { report: report("radarsu-rog") } }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.hostId).toBe("radarsu-rog-wsl-arch");
});

test("lets the device that answered take the row before one that only shares its name", () => {
    const merged = mergeDevices(
        [enrolled("radarsu-rog")],
        [{ machine: "radarsu-rog", report: report("radarsu-rog") }],
        [
            { host: host("radarsu-rog", { online: false, platform: "windows" }), result: { gap: "offline" } },
            { host: host("radarsu-rog-wsl"), result: { report: report("radarsu-rog") } },
        ],
    );
    expect(merged.find((row) => row.sync !== undefined)).toMatchObject({ hostId: "radarsu-rog-wsl", online: true });
    expect(merged.map((row) => row.hostId).toSorted()).toEqual(["radarsu-rog", "radarsu-rog-wsl"]);
});

test("keeps two devices apart when they report one hostname", () => {
    const merged = mergeDevices(
        [],
        [],
        [
            { host: host("win"), result: { report: report("radarsu-rog") } },
            { host: host("wsl"), result: { report: report("radarsu-rog") } },
        ],
    );
    expect(merged.map((row) => row.hostId)).toEqual(["win", "wsl"]);
    expect(new Set(merged.map((row) => row.key)).size).toBe(2);
});

test("keeps two machines apart when nothing says they are the same box", () => {
    const merged = mergeDevices(
        [enrolled("ada-laptop")],
        [{ machine: "ada-laptop", report: report("ada-box") }],
        [{ host: host("grace-pc"), result: { report: report("grace-box") } }],
    );
    expect(merged.map((row) => row.key)).toEqual(["ada-box", "grace-box"]);
    expect(merged.map((row) => row.sync?.mode)).toEqual(["sync", undefined]);
});

// Gap reasons (offline, scope-off, no-agent) must reach the UI distinct, not flattened.
test("carries the reason a reachable device produced nothing", () => {
    const merged = mergeDevices(
        [],
        [],
        [
            { host: host("asleep", { online: false }), result: { gap: "offline" } },
            { host: host("locked-down"), result: { gap: "scope-off" } },
            { host: host("bare"), result: { gap: "no-agent" } },
        ],
    );
    expect(merged.map((row) => row.gap)).toEqual(["offline", "scope-off", "no-agent"]);
    expect(merged.every((row) => row.sync === undefined)).toBe(true);
});

// Cache/dedupe tests: the pull cache is module-level, so each test uses its own machine id, not a shared one.

// A nonexistent path: sync contributes nothing, and no test here needs a real temp directory for history.
const NO_HISTORY = "/nonexistent/machine-reports-history";

interface FakeCall {
    readonly id: string;
    readonly tool: string;
    readonly signal: AbortSignal | undefined;
}

const answer = (text: string, isError = false): unknown => ({ result: { content: [{ text }], isError } });

const fakeServices = (id: string, mcp: (call: FakeCall) => Promise<unknown>): { services: Services; calls: FakeCall[] } => {
    const calls: FakeCall[] = [];
    const services = {
        config: { historyRoot: NO_HISTORY },
        perf: { track: async <T>(_op: string, _fields: unknown, run: () => Promise<T>): Promise<T> => await run() },
        capabilities: { list: async () => [{ kind: "host", id, config: { platform: "linux" } }] },
        hostHub: {
            state: () => ({ online: true, version: "0.1.0" }),
            mcp: async (asked: string, payload: unknown, options?: { signal?: AbortSignal }) => {
                const tool = (payload as { params?: { name?: string } }).params?.name ?? "";
                const call = { id: asked, tool, signal: options?.signal };
                calls.push(call);
                return await mcp(call);
            },
        },
    } as unknown as Services;
    return { services, calls };
};

afterEach(() => {
    vi.useRealTimers();
    published.length = 0;
});

test("waits for the first reading of a machine, then serves it while refreshing behind the answer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let hostname = "first";
    const { services, calls } = fakeServices("cached-pc", async (call) =>
        call.tool === "run_command" ? answer(statusEnvelope(report(hostname))) : answer("[]"),
    );

    expect((await devices(services))[0]?.report?.hostname).toBe("first");
    expect(calls).toHaveLength(2);

    hostname = "second";
    expect((await devices(services))[0]?.report?.hostname).toBe("first");
    expect(calls).toHaveLength(2);

    vi.setSystemTime(Date.now() + 31_000);
    expect((await devices(services))[0]?.report?.hostname).toBe("first");
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    expect((await devices(services))[0]?.report?.hostname).toBe("second");
});

// Handing over a reading the view would already call quiet is what made a healthy machine look dead the moment its
// page opened: the answer was contradicted a second later by the refresh behind it.
test("waits for the answer rather than serving a reading old enough to read as quiet", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let hostname = "before";
    const { services } = fakeServices("quiet-pc", async (call) =>
        call.tool === "run_command" ? answer(statusEnvelope(report(hostname, { capturedAt: Date.now() }))) : answer("[]"),
    );

    expect((await devices(services))[0]?.report?.hostname).toBe("before");

    hostname = "after";
    vi.setSystemTime(Date.now() + 61_000);
    expect((await devices(services))[0]?.report?.hostname).toBe("after");
});

// The browser maps `hosts` to its Devices read, so a machine that answers after the reader stopped waiting is on
// screen in a second instead of at the next ten-second poll. Silent on a routine refresh: news it already has.
test("announces only a landing that changes what the view says", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { services, calls } = fakeServices("push-pc", async (call) =>
        call.tool === "run_command" ? answer(statusEnvelope(report("push", { capturedAt: Date.now() }))) : answer("[]"),
    );

    // The machine's first reading: nothing was known about it before, so watchers are told.
    await devices(services);
    expect(published).toEqual(["hosts"]);
    published.length = 0;

    // A refresh of a reading still young enough to serve: same answer, no frame.
    vi.setSystemTime(Date.now() + 31_000);
    await devices(services);
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    expect(published).toEqual([]);

    // A reading that had gone quiet, replaced: the frame is the whole point of the wait ending early.
    vi.setSystemTime(Date.now() + 61_000);
    await devices(services);
    expect(published).toEqual(["hosts"]);
});

test("coalesces concurrent readers into a single round trip", async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { services, calls } = fakeServices("busy-pc", async (call) => {
        await held;
        return call.tool === "run_command" ? answer(statusEnvelope(report("busy"))) : answer("[]");
    });

    const readers = [devices(services), devices(services), devices(services)];
    release();
    const answers = await Promise.all(readers);

    expect(answers.every((rows) => rows[0]?.report?.hostname === "busy")).toBe(true);
    expect(calls.filter((call) => call.tool === "run_command")).toHaveLength(1);
});

// Uses a no-report status so the fleet call must still fire concurrently, not only when status succeeds.
test("asks for the status and the fleet in one go, and bounds the pair with one deadline", async () => {
    const { services, calls } = fakeServices("bare-pc", async (call) =>
        call.tool === "run_command" ? answer("intentic-machine: command not found", false) : answer("[]"),
    );

    expect((await devices(services))[0]?.gap).toBe("no-agent");
    expect(calls.map((call) => call.tool).toSorted()).toEqual(["list_sandboxes", "run_command"]);
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.signal).toBe(calls[1]?.signal);
});

test("a machine that refuses to answer at all reads as offline", async () => {
    const { services } = fakeServices("dead-pc", () => Promise.reject(new Error("socket is gone")));
    expect((await devices(services))[0]).toMatchObject({ hostId: "dead-pc", gap: "offline" });
});

// Runner lifecycle and the rebuild from source: the ops the daemon fills in for.

// Fixture exposing both the flow sent to the machine and what this side minted, revoked or disconnected.
const runnerServices = (
    overrides: { publicUrl?: string; online?: boolean; approved?: string; settings?: Record<string, unknown>; devRoot?: string } = {},
): { services: Services; sent: DeviceSandboxFlow[]; minted: string[]; revoked: string[]; disconnected: string[] } => {
    const sent: DeviceSandboxFlow[] = [];
    const minted: string[] = [];
    const revoked: string[] = [];
    const disconnected: string[] = [];
    const services = {
        config: {
            historyRoot: NO_HISTORY,
            sandbox: { publicUrl: overrides.publicUrl ?? "https://sandbox-x.intentic.dev", devRoot: overrides.devRoot },
        },
        // Backs runner-up's best-effort reads; empty here so nothing extra appears in the assertions below.
        workspace: { root: "/nowhere" },
        files: { read: async () => overrides.approved },
        sandboxSettings: { get: async () => ({ ...overrides.settings }) },
        runners: {
            mintPairing: (id: string) => {
                minted.push(id);
                return { token: `pair-for-${id}`, expiresIn: 600 };
            },
            revoke: async (id: string) => {
                revoked.push(id);
                return true;
            },
        },
        runnerHub: { disconnect: (id: string) => disconnected.push(id) },
        hostHub: {
            client:
                overrides.online === false
                    ? () => undefined
                    : () => ({
                          runSandboxFlow: async (flow: DeviceSandboxFlow) => {
                              sent.push(flow);
                              return (async function* () {
                                  yield { kind: "line", text: "working" } as const;
                                  yield { kind: "result", message: "done" } as const;
                              })();
                          },
                      }),
        },
    } as unknown as Services;
    return { services, sent, minted, revoked, disconnected };
};

const drain = async (flow: AsyncGenerator<DeviceFlowLine>): Promise<DeviceFlowLine[]> => {
    const lines: DeviceFlowLine[] = [];
    for await (const line of flow) {
        lines.push(line);
    }
    return lines;
};

// The daemon mints the pairing; a caller only names a machine and a runner, never carries a credential in.
test("starting a runner fills in this sandbox's address and a pairing bound to the runner's own name", async () => {
    const { services, sent, minted } = runnerServices();
    await drain(manageDeviceSandbox(services, "rog", { op: "runner-up", slug: "rig" }));
    expect(minted).toEqual(["rig"]);
    expect(sent[0]).toEqual({ op: "runner-up", slug: "rig", parentUrl: "https://sandbox-x.intentic.dev", pair: "pair-for-rig" });
});

test("a sandbox with no public address refuses rather than leaving a container with no way home", async () => {
    const { services, sent, minted } = runnerServices({ publicUrl: "" });
    await expect(drain(manageDeviceSandbox(services, "rog", { op: "runner-up", slug: "rig" }))).rejects.toThrow(/public address/i);
    expect(minted).toEqual([]);
    expect(sent).toEqual([]);
});

// Pairing injection applies only to `runner-up`; every other op passes through untouched.
test("no other op grows a pairing", async () => {
    const { services, sent, minted } = runnerServices();
    await drain(manageDeviceSandbox(services, "rog", { op: "update", slug: "work" }));
    expect(sent[0]).toEqual({ op: "update", slug: "work" });
    expect(minted).toEqual([]);
});

// The checkout is this side's own knowledge, like the pairing above: a caller names an op, never a path on somebody's
// machine, so one arriving in the payload is replaced rather than honoured.
test("a rebuild from source carries the checkout this sandbox records, not one the caller named", async () => {
    const { services, sent } = runnerServices({ devRoot: "/home/ada/intentic" });
    await drain(manageDeviceSandbox(services, "rog", { op: "dev-rebuild", slug: "work", root: "/tmp/somewhere-else" }));
    expect(sent[0]).toEqual({ op: "dev-rebuild", slug: "work", root: "/home/ada/intentic" });
});

test("a sandbox with no checkout recorded refuses the rebuild instead of sending a machine a guess", async () => {
    const { services, sent } = runnerServices();
    await expect(drain(manageDeviceSandbox(services, "rog", { op: "dev-rebuild", slug: "work" }))).rejects.toThrow(/checkout/i);
    expect(sent).toEqual([]);
});

// The approved overlay ships byte-exact with its sha256 (checked again on the machine); non-default settings ship as a
// definition seed.
test("starting a runner ships the approved overlay with its pinning hash and the settings as a seed", async () => {
    const approved = "FROM ghcr.io/intentic/sandbox:stable\nRUN true\n";
    const { services, sent } = runnerServices({ approved, settings: { hashlineEdits: true } });
    await drain(manageDeviceSandbox(services, "rog", { op: "runner-up", slug: "rig" }));
    const flow = sent[0] as DeviceSandboxFlow;
    expect(flow.overlay).toBe(approved);
    expect(flow.overlayHash).toBe(sha256Hex(approved));
    expect(flow.definition).toContain("hashlineEdits = true");
    expect(flow.definition).not.toContain("[[capabilities]]");
    expect(flow.definition).not.toContain("secrets");
});

test("a removed runner loses its enrollment here, but only when the machine says it worked", async () => {
    const { services, revoked, disconnected } = runnerServices();
    await drain(manageDeviceSandbox(services, "rog", { op: "runner-remove", slug: "rig" }));
    expect(revoked).toEqual(["rig"]);
    expect(disconnected).toEqual(["rig"]);
});
