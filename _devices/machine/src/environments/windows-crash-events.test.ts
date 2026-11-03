import { HOST_CRASH_LOOKBACK_MS, HOST_CRASHES_MAX, type HostCrashEvent } from "@intentic/sandbox-contract/schemas/hosts";
import { CRASH_REFRESH_MS, crashEventsFrom, createCrashWatch, crashScript } from "./windows-crash-events.js";

// Shaped like the script's ConvertTo-Json output: the fields Get-WinEvent gives, plus WER's properties.
const wer = (recordId: number, at: string, p1: string, eventName = "LiveKernelEvent") => ({
    LogName: "Application",
    RecordId: recordId,
    Id: 1001,
    ProviderName: "Windows Error Reporting",
    TimeCreated: at,
    Message: `Fault bucket , type 0\r\nEvent Name: ${eventName}\r\nResponse: Not available\r\nCab Id: 0\r\n\r\nProblem signature:\r\nP1: ${p1}\r\nP2: aaaaaaaaaaaaaaaa`,
    EventName: eventName,
    P1: p1,
    Data0: null,
});

// rog, 2026-11-02: the 0x141 at 19:30 and the benign 0x193 live dump three minutes later, as WER logged them.
const ROG = [
    wer(9001, "2026-11-02T19:31:12.0000000Z", "141"),
    wer(9002, "2026-11-02T19:34:01.0000000Z", "193"),
    {
        LogName: "System",
        RecordId: 48213,
        Id: 41,
        ProviderName: "Microsoft-Windows-Kernel-Power",
        TimeCreated: "2026-11-02T19:33:40.1234567Z",
        Message: "The system has rebooted without cleanly shutting down first. This error could be caused if the system stopped responding, crashed, or lost power unexpectedly.",
    },
    {
        LogName: "System",
        RecordId: 48100,
        Id: 4101,
        ProviderName: "Display",
        TimeCreated: "2026-11-02T19:30:50.0000000Z",
        Message: "Display driver nvlddmkm stopped responding and has successfully recovered.",
    },
];

test("rog's night reads as two GPU resets and a host crash, newest first, the 0x193 live dump left out", () => {
    const events = crashEventsFrom(JSON.stringify(ROG));
    const expected: HostCrashEvent[] = [
        {
            id: "System:48213",
            at: "2026-11-02T19:33:40.123Z",
            kind: "host-crash",
            code: "Kernel-Power 41",
            detail: "The system has rebooted without cleanly shutting down first. This error could be caused if the system stopped responding, crashed, or lost power unexpectedly.",
        },
        {
            id: "Application:9001",
            at: "2026-11-02T19:31:12.000Z",
            kind: "gpu-reset",
            code: "LiveKernelEvent 141",
            detail: "Windows Error Reporting: LiveKernelEvent 141 (VIDEO_ENGINE_TIMEOUT_DETECTED)",
        },
        {
            id: "System:48100",
            at: "2026-11-02T19:30:50.000Z",
            kind: "gpu-reset",
            code: "Display 4101",
            detail: "Display driver nvlddmkm stopped responding and has successfully recovered.",
        },
    ];
    expect(events).toEqual(expected);
});

test("one event is a bare object, none is empty output or an empty array", () => {
    expect(crashEventsFrom(JSON.stringify(ROG[0])).map((event) => event.code)).toEqual(["LiveKernelEvent 141"]);
    expect(crashEventsFrom("")).toEqual([]);
    expect(crashEventsFrom("  \r\n")).toEqual([]);
    expect(crashEventsFrom("[]")).toEqual([]);
    expect(crashEventsFrom("WARNING: something")).toEqual([]);
});

test("WER's P1 is read from the message when the properties are missing, and only the display driver's codes count", () => {
    const fromMessage = { ...wer(1, "2026-11-02T10:00:00Z", "117"), EventName: null, P1: null };
    expect(crashEventsFrom(JSON.stringify([fromMessage]))[0]?.code).toBe("LiveKernelEvent 117");
    expect(crashEventsFrom(JSON.stringify([wer(2, "2026-11-02T10:00:00Z", "0x00000116")]))[0]?.code).toBe("LiveKernelEvent 116");
    expect(crashEventsFrom(JSON.stringify([wer(3, "2026-11-02T10:00:00Z", "1a8")]))).toEqual([]);
    expect(crashEventsFrom(JSON.stringify([wer(4, "2026-11-02T10:00:00Z", "141", "BlueScreen")]))).toEqual([]);
});

test("a bugcheck is a GPU reset for the display driver's codes and a host crash for any other", () => {
    const bugcheck = (recordId: number, code: string) => ({
        LogName: "System",
        RecordId: recordId,
        Id: 1001,
        ProviderName: "Microsoft-Windows-WER-SystemErrorReporting",
        TimeCreated: "2026-09-12T08:00:00.0000000Z",
        Message: `The computer has rebooted from a bugcheck.  The bugcheck was: ${code} (0xffffd40e1c3b4010, 0xfffff8063f3e6f40, 0xffffffffc000009a, 0x0000000000000004). A dump was saved in: C:\\WINDOWS\\MEMORY.DMP.`,
        Data0: `${code} (0xffffd40e1c3b4010, 0xfffff8063f3e6f40, 0xffffffffc000009a, 0x0000000000000004)`,
    });
    const events = crashEventsFrom(JSON.stringify([bugcheck(1, "0x00000116"), bugcheck(2, "0x0000009f")]));
    expect(events.map((event) => [event.code, event.kind])).toEqual([
        ["BugCheck 0x116", "gpu-reset"],
        ["BugCheck 0x9f", "host-crash"],
    ]);
});

test("a System 1001 or 41 from another provider is not a crash, nor is an event with no time", () => {
    const other = { LogName: "System", RecordId: 5, Id: 41, ProviderName: "Some-Driver", TimeCreated: "2026-11-02T10:00:00Z", Message: "x" };
    const timeless = { ...ROG[3], TimeCreated: "" };
    expect(crashEventsFrom(JSON.stringify([other, timeless]))).toEqual([]);
});

test("the answer is capped and each event appears once", () => {
    const many = Array.from({ length: HOST_CRASHES_MAX + 5 }, (_, index) => wer(index, new Date(Date.UTC(2026, 10, 2, 0, index)).toISOString(), "141"));
    const events = crashEventsFrom(JSON.stringify([...many, many[0]]));
    expect(events).toHaveLength(HOST_CRASHES_MAX);
    expect(events[0]?.id).toBe(`Application:${String(HOST_CRASHES_MAX + 4)}`);
});

test("the script reads from a day back, in Unix ms", () => {
    expect(crashScript(1_800_000_000_000)).toContain("FromUnixTimeMilliseconds(1800000000000)");
    expect(crashScript(1_800_000_000_000)).toContain("Id = 41, 1001, 4101");
});

// The query's answer and its bookkeeping, both a few promise steps away.
const settle = async (): Promise<void> => await new Promise((resolve) => setTimeout(resolve, 0));

test("the watch asks at most once a minute, never twice at once, keeps its last answer on a failure and says so once", async () => {
    let now = Date.parse("2026-11-02T20:00:00Z");
    const asked: number[] = [];
    const logged: string[] = [];
    let answer: () => Promise<HostCrashEvent[]> = async () => crashEventsFrom(JSON.stringify(ROG));
    const watch = createCrashWatch({
        query: async (at) => {
            asked.push(at);
            return await answer();
        },
        log: (message) => logged.push(message),
        now: () => now,
    });
    expect(watch.current()).toEqual([]);
    expect(watch.current()).toEqual([]);
    await settle();
    expect(asked).toHaveLength(1);
    expect(watch.current().map((event) => event.code)).toEqual(["Kernel-Power 41", "LiveKernelEvent 141", "Display 4101"]);
    answer = async () => {
        throw new Error("The RPC server is unavailable.");
    };
    for (const step of [1, 2]) {
        now += CRASH_REFRESH_MS;
        watch.current();
        await settle();
        expect(asked).toHaveLength(1 + step);
    }
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("The RPC server is unavailable.");
    // A day after the events, they are no longer answered.
    now = Date.parse("2026-11-02T19:33:40.123Z") + HOST_CRASH_LOOKBACK_MS + 1;
    expect(watch.current().map((event) => event.code)).toEqual([]);
});

// Measured on rog, 2026-11-03: WER logs each queued report again every few minutes until it uploads, so the 2026-11-02
// LiveKernelEvent 141 and three 117s from July to September all arrived as new events at 12:34 that day. Read by their
// record they were four fresh GPU resets, and a new one after every resume; by their report and dump they are what
// they were. The rows below are the script's real answer there, messages cut.
const relogged = (recordId: number, p1: string, report: string, dump: string) => ({
    ...wer(recordId, "2026-11-03T12:34:28.5894408Z", p1),
    Key: `WER:${report}`,
    DumpTime: dump,
});

test("a report Windows logs again is one event, dated by its dump rather than by the log entry", () => {
    const answer = [
        relogged(37809, "117", "18d4e572-b63e-4d3d-823f-d5bf6d763bbc", "2026-08-29T08:10:00.0000000Z"),
        relogged(37819, "141", "a0fdf9d8-473f-4ee3-886c-99373183caee", "2026-11-02T19:30:00.0000000Z"),
        relogged(37777, "141", "a0fdf9d8-473f-4ee3-886c-99373183caee", "2026-11-02T19:30:00.0000000Z"),
    ];
    expect(crashEventsFrom(JSON.stringify(answer)).map((event) => [event.id, event.at, event.code])).toEqual([
        ["WER:a0fdf9d8-473f-4ee3-886c-99373183caee", "2026-11-02T19:30:00.000Z", "LiveKernelEvent 141"],
        ["WER:18d4e572-b63e-4d3d-823f-d5bf6d763bbc", "2026-08-29T08:10:00.000Z", "LiveKernelEvent 117"],
    ]);
});
