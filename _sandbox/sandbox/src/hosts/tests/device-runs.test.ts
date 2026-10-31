import { createDeviceRuns, type DeviceToolArgs, linesSince, parseRunList, parseRunLogs, startedRun } from "../runs/device-runs.js";

// What a computer's app_* tools say about the programs this sandbox started there, read back into runs the Run dialog
// shows and stops; the sentences are the machine's own (devices/machine/src/device/tools/programs/programs.ts).

const STATUS = [
    "3 program run(s), newest first:",
    "▶ local-server-1a2b3c  local-server  running, pid 4120  (started 2026-10-31T10:00:00.000Z)",
    "■ local-server-0f0f0f  local-server  exited with code 101  (started 2026-10-31T09:00:00.000Z, ended 2026-10-31T09:05:00.000Z)",
    "■ game-ffffff  game  exited with 0xC0000135: a DLL it needs was not found  (started 2026-10-30T09:00:00.000Z, ended 2026-10-30T09:00:01.000Z)",
    "■ tool-aaaaaa  tool  ended (its exit code is unknown: it ended while the agent was not watching)  (started 2026-10-29T09:00:00.000Z, ended 2026-10-29T10:00:00.000Z)",
    "",
    "Builds pushed here (devices push), newest first:",
    "  local-server/abc  C:\\Users\\radar\\.intentic\\runs\\local-server\\abc",
].join("\n");

test("app_status's list reads as runs: state, the machine's words, how each ended", () => {
    expect(parseRunList(STATUS)).toEqual([
        { id: "local-server-1a2b3c", name: "local-server", state: "running", said: "running, pid 4120", startedAt: "2026-10-31T10:00:00.000Z" },
        {
            id: "local-server-0f0f0f",
            name: "local-server",
            state: "ended",
            said: "exited with code 101",
            exitCode: 101,
            startedAt: "2026-10-31T09:00:00.000Z",
            endedAt: "2026-10-31T09:05:00.000Z",
        },
        expect.objectContaining({ id: "game-ffffff", exitCode: 0xc0000135 }),
        expect.objectContaining({ id: "tool-aaaaaa", state: "ended", said: expect.stringContaining("unknown") }),
    ]);
    expect(parseRunList("Nothing has been started here by this sandbox.")).toEqual([]);
});

test("app_logs reads as the run, the log's size and what it printed", () => {
    const logs = parseRunLogs(
        [
            "▶ local-server-1a2b3c  local-server  running, pid 4120  (started 2026-10-31T10:00:00.000Z)",
            "C:\\runs\\.logs\\local-server-1a2b3c.log, 42 bytes:",
            "listening on 127.0.0.1:7880",
            "client joined",
        ].join("\n"),
    );
    expect(logs).toEqual({
        run: expect.objectContaining({ id: "local-server-1a2b3c", state: "running" }),
        total: 42,
        lines: ["listening on 127.0.0.1:7880", "client joined"],
    });
    const quiet = parseRunLogs(
        [
            "▶ app-1a2b3c  app  running, pid 1  (started 2026-10-31T10:00:00.000Z)",
            "C:\\runs\\.logs\\app-1a2b3c.log, 0 bytes:",
            "(nothing printed yet; a GUI program often prints nothing at all)",
        ].join("\n"),
    );
    expect(quiet.lines).toEqual([]);
});

test("app_start's answer names the run it started, or the one that fell over at once", () => {
    expect(startedRun("Started local-server as local-server-1a2b3c (pid 4120) in C:\\runs. Its output goes to …")).toEqual({
        id: "local-server-1a2b3c",
        ended: false,
    });
    expect(startedRun("Started app as app-1a2b3c inside Windows Sandbox: it boots …")).toEqual({ id: "app-1a2b3c", ended: false });
    expect(startedRun("local-server (local-server-1a2b3c) exited with 0xC0000135: a DLL it needs was not found within 1.5s of starting.")).toEqual({
        id: "local-server-1a2b3c",
        ended: true,
    });
    expect(startedRun("something else entirely")).toBeUndefined();
});

test("a follow gets only the lines printed after its last read", () => {
    const tail = ["one", "two", "three"];
    expect(linesSince(tail, 14, 14)).toEqual([]);
    expect(linesSince(tail, 14, 8)).toEqual(["three"]);
    expect(linesSince(tail, 14, 4)).toEqual(["two", "three"]);
    // A log started again is all new.
    expect(linesSince(tail, 14, 900)).toEqual(tail);
});

const tunnels = () => {
    const closed: string[] = [];
    return {
        closed,
        tunnels: { close: async (device: string, port: number): Promise<boolean> => closed.push(`${device}:${port}`) > 0 },
    };
};

test("stopping a run closes the ports opened for it, except one another running run there still holds", async () => {
    const calls: { tool: string; args: DeviceToolArgs }[] = [];
    const { closed, tunnels: held } = tunnels();
    const runs = createDeviceRuns({
        call: async (_device, tool, args) => {
            calls.push({ tool, args });
            return { text: tool === "app_status" ? STATUS : `Stopped ${String(args["id"])}, with everything it started.`, refused: false };
        },
        tunnels: () => held,
        logger: { info: () => {} },
    });
    runs.started("rog", "local-server-1a2b3c", { name: "local-server", repo: "integra", ports: [7880, 9000] });
    runs.started("rog", "other-123456", { name: "other", ports: [9000] });
    expect(await runs.stopNamed("rog", "local-server")).toEqual([{ id: "local-server-1a2b3c", text: expect.stringContaining("Stopped") }]);
    expect(calls.filter((call) => call.tool === "app_stop")).toEqual([{ tool: "app_stop", args: { id: "local-server-1a2b3c", force: false } }]);
    expect(closed).toEqual(["rog:7880"]);
    expect(runs.deviceOf("local-server-1a2b3c")).toBe("rog");
});

test("a run found ended gives its ports back, and a listed run carries its repository and open ports", async () => {
    const { closed, tunnels: held } = tunnels();
    const runs = createDeviceRuns({ call: async () => ({ text: STATUS, refused: false }), tunnels: () => held, logger: { info: () => {} } });
    runs.started("rog", "local-server-1a2b3c", { name: "local-server", repo: "integra", ports: [7880] });
    runs.started("rog", "local-server-0f0f0f", { name: "local-server", repo: "integra", ports: [7000] });
    const listed = await runs.list("rog");
    expect(listed[0]).toMatchObject({ device: "rog", repo: "integra", ports: [7880] });
    expect(listed[1]).toMatchObject({ ports: [] });
    expect(closed).toEqual(["rog:7000"]);
});

test("the computer's refusal is thrown as its own words", async () => {
    const { tunnels: held } = tunnels();
    const runs = createDeviceRuns({
        call: async () => ({ text: "Run programs is off on this device.", refused: true }),
        tunnels: () => held,
        logger: { info: () => {} },
    });
    await expect(runs.stop("rog", "x-123456")).rejects.toThrow("Run programs is off");
});
