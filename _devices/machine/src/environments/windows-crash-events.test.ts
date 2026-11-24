import { HOST_CRASH_LOOKBACK_MS, HOST_CRASHES_MAX, type HostCrashEvent } from "@intentic/sandbox-contract/schemas/hosts";
import { CRASH_REBASE_MS, CRASH_REFRESH_MS, type CrashMarks, crashAnswerFrom, crashEventsFrom, crashScript, crashXPaths, createCrashWatch } from "./windows-crash-events.js";

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

test("the whole day is asked by XPath, filtered by the event log service: ids, provider, a day back in ms, and WER's LiveKernelEvents alone", () => {
    const paths = crashXPaths(HOST_CRASH_LOOKBACK_MS);
    expect(paths.System).toBe("*[System[(EventID=41 or EventID=1001 or EventID=4101) and TimeCreated[timediff(@SystemTime) <= 86400000]]]");
    expect(paths.Application).toBe(
        "*[System[Provider[@Name='Windows Error Reporting'] and EventID=1001 and TimeCreated[timediff(@SystemTime) <= 86400000]] and EventData[Data='LiveKernelEvent']]",
    );
    const script = crashScript(HOST_CRASH_LOOKBACK_MS);
    expect(script).toContain(`@{ Log = 'System'; Path = "${paths.System}" }`);
    expect(script).toContain(`@{ Log = 'Application'; Path = "${paths.Application}" }`);
    expect(script).toContain("Get-WinEvent -LogName $query.Log -FilterXPath $query.Path");
    // No date of the locale is parsed, and no message is rendered to choose which events to keep.
    expect(script).not.toContain("StartTime");
    expect(script).not.toContain("-match 'LiveKernelEvent'");
});

test("a later query asks only for the records after the last one each log answered with", () => {
    const paths = crashXPaths(HOST_CRASH_LOOKBACK_MS, { System: 25_064, Application: 47_938 });
    expect(paths.System).toContain("(EventID=41 or EventID=1001 or EventID=4101) and EventRecordID > 25064 and TimeCreated");
    expect(paths.Application).toContain("EventID=1001 and EventRecordID > 47938 and TimeCreated");
    // A log with no mark is asked for its whole day.
    expect(crashXPaths(HOST_CRASH_LOOKBACK_MS, { System: 7 }).Application).not.toContain("EventRecordID");
    expect(crashScript(HOST_CRASH_LOOKBACK_MS, { System: 25_064 })).toContain("EventRecordID > 25064");
    // The newest record each log answered with comes back with the rows.
    expect(crashScript(HOST_CRASH_LOOKBACK_MS)).toContain("$last[$query.Log] = ($got | Measure-Object -Property RecordId -Maximum).Maximum");
    expect(crashScript(HOST_CRASH_LOOKBACK_MS)).toContain("ConvertTo-Json -InputObject ([pscustomobject]@{ rows = $rows; last = $last })");
});

test("the answer is its rows' events and each log's last record; anything else is nothing", () => {
    const answer = crashAnswerFrom(JSON.stringify({ rows: ROG, last: { System: 48_213, Application: 9002 } }));
    expect(answer.events.map((event) => event.code)).toEqual(["Kernel-Power 41", "LiveKernelEvent 141", "Display 4101"]);
    expect(answer.last).toEqual({ System: 48_213, Application: 9002 });
    // As rog answered with nothing new (measured 2026-11-24).
    expect(crashAnswerFrom('{"rows":[],"last":{}}')).toEqual({ events: [], last: {} });
    // One row written as a bare object.
    expect(crashAnswerFrom(JSON.stringify({ rows: ROG[0], last: { Application: 9001 } })).events).toHaveLength(1);
    expect(crashAnswerFrom("WARNING: something")).toEqual({ events: [], last: {} });
    expect(crashAnswerFrom("[]")).toEqual({ events: [], last: {} });
});

// The query's answer and its bookkeeping, both a few promise steps away.
const settle = async (): Promise<void> => await new Promise((resolve) => setTimeout(resolve, 0));

test("the watch asks at most every five minutes, never twice at once, keeps its last answer on a failure and says so once", async () => {
    let now = Date.parse("2026-11-02T20:00:00Z");
    const asked: CrashMarks[] = [];
    const logged: string[] = [];
    let answer: () => Promise<ReturnType<typeof crashAnswerFrom>> = async () => crashAnswerFrom(JSON.stringify({ rows: ROG, last: { System: 48_213, Application: 9002 } }));
    const watch = createCrashWatch({
        query: async (after) => {
            asked.push(after);
            return await answer();
        },
        log: (message) => logged.push(message),
        now: () => now,
    });
    expect(CRASH_REFRESH_MS).toBe(5 * 60_000);
    expect(watch.current()).toEqual([]);
    expect(watch.current()).toEqual([]);
    await settle();
    expect(asked).toEqual([{}]);
    expect(watch.current().map((event) => event.code)).toEqual(["Kernel-Power 41", "LiveKernelEvent 141", "Display 4101"]);
    now += CRASH_REFRESH_MS - 1;
    watch.current();
    await settle();
    expect(asked).toHaveLength(1);
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

test("later queries start after the marks and add to what was held; a report logged again stays the event it was", async () => {
    let now = Date.parse("2026-11-02T20:00:00Z");
    const asked: CrashMarks[] = [];
    const answers = [
        { rows: ROG, last: { System: 48_213, Application: 9002 } },
        // Nothing new in System (no mark back: the old one stands); a new 117 in Application.
        { rows: [wer(9010, "2026-11-02T20:04:00Z", "117")], last: { Application: 9010 } },
    ];
    const watch = createCrashWatch({
        query: async (after) => {
            asked.push(after);
            return crashAnswerFrom(JSON.stringify(answers.shift() ?? { rows: [], last: {} }));
        },
        log: () => undefined,
        now: () => now,
    });
    watch.current();
    await settle();
    now += CRASH_REFRESH_MS;
    watch.current();
    await settle();
    expect(asked).toEqual([{}, { System: 48_213, Application: 9002 }]);
    expect(watch.current().map((event) => event.code)).toEqual(["LiveKernelEvent 117", "Kernel-Power 41", "LiveKernelEvent 141", "Display 4101"]);
    now += CRASH_REFRESH_MS;
    watch.current();
    await settle();
    expect(asked[2]).toEqual({ System: 48_213, Application: 9010 });
});

test("asked fresh, the watch queries at once; the whole day is asked again every few hours", async () => {
    let now = Date.parse("2026-11-02T20:00:00Z");
    const asked: CrashMarks[] = [];
    const watch = createCrashWatch({
        query: async (after) => {
            asked.push(after);
            return { events: [], last: { System: 10, Application: 20 } };
        },
        log: () => undefined,
        now: () => now,
    });
    watch.current();
    await settle();
    watch.current({ fresh: true });
    await settle();
    expect(asked).toEqual([{}, { System: 10, Application: 20 }]);
    now += CRASH_REBASE_MS;
    watch.current();
    await settle();
    // A cleared log starts its records over: the whole day again, not from a mark past them.
    expect(asked[2]).toEqual({});
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
