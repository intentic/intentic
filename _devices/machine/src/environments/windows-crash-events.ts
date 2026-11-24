import { errorMessage } from "@intentic/base/errors";
import { execBounded } from "@intentic/base/process";
import { HOST_CRASH_LOOKBACK_MS, HOST_CRASHES_MAX, type HostCrashEvent } from "@intentic/sandbox-contract/schemas/hosts";
import { z } from "zod";
import { WINDOWS_SIDE } from "./wsl.js";

/* WINDOWS' OWN RECORD OF A GPU RESET OR A CRASH (2026-11-03). On 2026-11-02 a sandbox agent's browser rendered on rog's
   display GPU through WSL; the driver lost the device (LiveKernelEvent 0x141) and the PC powered off, and the sandbox
   could only say its daemon had been "killed without warning". Windows logs every such event, so the Windows side reads
   the last day of them and answers each heartbeat with them (schemas/hosts.ts, HostCrashEventSchema): the sandbox names
   them where it explains a restart and pauses GPU work after a GPU reset. Which events count:
   - System, Display 4101: "Display driver stopped responding and has successfully recovered", a TDR → gpu-reset;
   - System, Kernel-Power 41: Windows rebooted without shutting down cleanly, logged at the next boot → host-crash;
   - System, WER-SystemErrorReporting 1001: rebooted from a bugcheck; 0x116/0x117/0x141 are the display driver's →
     gpu-reset, any other code → host-crash;
   - Application, Windows Error Reporting 1001 for a LiveKernelEvent with P1 141, 117 or 116 (the driver's timeout or
     reset, written even when Windows survives) → gpu-reset. P1 193 and the rest are left out: rog writes benign 193 live
     dumps every few days. */

// The display driver's own bugcheck and live-dump codes, each as P1 writes it (hex, no 0x), with Windows' name for it.
const GPU_CODES = new Map([
    ["116", "VIDEO_TDR_FAILURE"],
    ["117", "VIDEO_TDR_TIMEOUT_DETECTED"],
    ["141", "VIDEO_ENGINE_TIMEOUT_DETECTED"],
]);

const KERNEL_POWER = "Microsoft-Windows-Kernel-Power";
const BUGCHECK = "Microsoft-Windows-WER-SystemErrorReporting";
const WER = "Windows Error Reporting";

// A field PowerShell may write as a string, a number or null: read as a string, empty when absent or anything else.
const field = z
    .union([z.string(), z.number()])
    .transform(String)
    .optional()
    .catch(undefined)
    .transform((value) => value ?? "");

// One event as the script answers it: what Get-WinEvent gives, plus WER's event name and P1 and a bugcheck's first data
// field, read from the event's properties (language-neutral, where the message text is translated).
const RawEventSchema = z.object({
    LogName: field,
    RecordId: field,
    Id: field,
    ProviderName: field,
    TimeCreated: field,
    Message: field,
    EventName: field,
    P1: field,
    Data0: field,
    // A WER report's own identity (`WER:<report id>`) and when its dump was taken, UTC: see crashScript.
    Key: field,
    DumpTime: field,
});
type RawEvent = z.infer<typeof RawEventSchema>;

// "0x00000141", "141", "0141" → "141"; undefined for nothing hex.
const hexCode = (value: string): string | undefined => {
    const digits = /^(?:0x)?([0-9a-f]+)$/i.exec(value.trim())?.[1];
    return digits === undefined ? undefined : digits.replace(/^0+(?=.)/, "").toLowerCase();
};

const firstLine = (message: string): string =>
    message
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line !== "") ?? "";

// Windows' first line about it, when it said one.
const said = (raw: RawEvent): { detail?: string } => {
    const line = firstLine(raw.Message).slice(0, 400);
    return line === "" ? {} : { detail: line };
};

type Classified = Omit<HostCrashEvent, "id" | "at">;

// A bugcheck the machine rebooted from: the display driver's codes are a GPU reset, any other a crash.
const bugcheck = (raw: RawEvent): Classified | undefined => {
    const hex = /0x([0-9a-f]{1,8})\b/i.exec(`${raw.Data0} ${raw.Message}`)?.[1];
    const code = hex === undefined ? undefined : hexCode(hex);
    if (code === undefined) {
        return undefined;
    }
    return { kind: GPU_CODES.has(code) ? "gpu-reset" : "host-crash", code: `BugCheck 0x${code}`, ...said(raw) };
};

// A live kernel event WER reported: only the display driver's timeouts and resets.
const liveKernelEvent = (raw: RawEvent): Classified | undefined => {
    const eventName = raw.EventName.trim() || (/Event Name:\s*(\S+)/i.exec(raw.Message)?.[1] ?? "");
    const p1 = hexCode(raw.P1) ?? hexCode(/^\s*P1:\s*(\S+)/im.exec(raw.Message)?.[1] ?? "");
    const name = p1 === undefined ? undefined : GPU_CODES.get(p1);
    if (eventName !== "LiveKernelEvent" || name === undefined) {
        return undefined;
    }
    return { kind: "gpu-reset", code: `LiveKernelEvent ${String(p1)}`, detail: `Windows Error Reporting: LiveKernelEvent ${String(p1)} (${name})` };
};

// Which of the four an event is, by its log, id and provider.
const classify = (raw: RawEvent): Classified | undefined => {
    const where = `${raw.LogName}|${raw.Id}`;
    if (where === "System|4101") {
        return { kind: "gpu-reset", code: "Display 4101", ...said(raw) };
    }
    if (where === "System|41" && raw.ProviderName === KERNEL_POWER) {
        return { kind: "host-crash", code: "Kernel-Power 41", ...said(raw) };
    }
    if (where === "System|1001" && raw.ProviderName === BUGCHECK) {
        return bugcheck(raw);
    }
    return where === "Application|1001" && raw.ProviderName === WER ? liveKernelEvent(raw) : undefined;
};

// What one logged event is, or undefined when it is none of the four above. Pure.
// A WER report is identified by its report id and dated by its dump, not by the event that logged it: Windows logs a
// queued report again every few minutes until it uploads (measured on rog, 2026-11-03: the 2026-11-02 LiveKernelEvent
// 141 and three 117s from July to September, re-logged as new events at 12:28, 12:33 and 12:34), so by its record it
// would read as a fresh GPU reset forever, and pause GPU work again after every resume.
const crashEventOf = (raw: RawEvent): HostCrashEvent | undefined => {
    const dumped = Date.parse(raw.DumpTime);
    const at = Number.isFinite(dumped) ? dumped : Date.parse(raw.TimeCreated);
    if (raw.LogName === "" || raw.RecordId === "" || !Number.isFinite(at)) {
        return undefined;
    }
    const classified = classify(raw);
    const id = raw.Key === "" ? `${raw.LogName}:${raw.RecordId}` : raw.Key;
    return classified === undefined ? undefined : { id: id.slice(0, 120), at: new Date(at).toISOString(), ...classified };
};

// The script's answer as events, newest first, at most HOST_CRASHES_MAX. ConvertTo-Json writes a bare object for one
// event and nothing for none, and anything unreadable is no events rather than an error the heartbeat would carry. Pure.
export const crashEventsFrom = (json: string): HostCrashEvent[] => {
    const trimmed = json.trim();
    if (trimmed === "") {
        return [];
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        // allow(silent-catch): output that is not JSON (a PowerShell warning) reads as no events; the next refresh asks again
        return [];
    }
    const raws = (Array.isArray(parsed) ? parsed : [parsed]).flatMap((item) => {
        const raw = RawEventSchema.safeParse(item);
        return raw.success ? [raw.data] : [];
    });
    const seen = new Set<string>();
    const events: HostCrashEvent[] = [];
    for (const raw of raws) {
        const event = crashEventOf(raw);
        if (event !== undefined && !seen.has(event.id)) {
            seen.add(event.id);
            events.push(event);
        }
    }
    return events.toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, HOST_CRASHES_MAX);
};

// The last record each log answered with: a later query asks only for records after it (crashScript).
export interface CrashMarks {
    readonly System?: number | undefined;
    readonly Application?: number | undefined;
}

// (2026-11-24) The two queries, filtered by the event log service itself: the ids, the provider, the records after the
// last one seen, the last day, and for WER only the reports whose event data names a LiveKernelEvent. The old query took
// every Application 1001 of the day and rendered each one's `.Message` to find those, and WER logs every application
// crash on the machine there. The time bound is `timediff`, in ms before now, so no date format of the locale is parsed.
export const crashXPaths = (lookbackMs: number, after: CrashMarks = {}) => {
    const since = `TimeCreated[timediff(@SystemTime) <= ${Math.round(lookbackMs)}]`;
    const from = (mark: number | undefined): string => (mark === undefined ? "" : ` and EventRecordID > ${Math.trunc(mark)}`);
    return {
        System: `*[System[(EventID=41 or EventID=1001 or EventID=4101)${from(after.System)} and ${since}]]`,
        Application: `*[System[Provider[@Name='${WER}'] and EventID=1001${from(after.Application)} and ${since}] and EventData[Data='LiveKernelEvent']]`,
    };
};

// The script. A log with no matching event is no events, never an error. WER's reports come one row per report
// (crashEventOf says why), each with the time in its dump's name (`WATCHDOG-20261102-2030.dmp`, Windows' local time) and
// only the head of its message: a day of re-logged reports ran to 700 KB whole. `last` is the newest record each log
// answered with, which the next query starts after.
export const crashScript = (lookbackMs: number, after: CrashMarks = {}): string => {
    const paths = crashXPaths(lookbackMs, after);
    return [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        "$found = @()",
        "$last = @{}",
        `foreach ($query in @(@{ Log = 'System'; Path = "${paths.System}" }, @{ Log = 'Application'; Path = "${paths.Application}" })) { try { $got = @(Get-WinEvent -LogName $query.Log -FilterXPath $query.Path -ErrorAction Stop); if ($got.Count -gt 0) { $last[$query.Log] = ($got | Measure-Object -Property RecordId -Maximum).Maximum }; $found += $got } catch { if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { throw } } }`,
        `$rows = @($found | ForEach-Object { $p = $_.Properties; $m = [string]$_.Message; $app = $_.LogName -eq 'Application'; $dump = ''; $key = ''; if ($app -and $m -match 'WATCHDOG-([0-9]{8}-[0-9]{4})') { $dump = [datetime]::ParseExact($Matches[1], 'yyyyMMdd-HHmm', [Globalization.CultureInfo]::InvariantCulture).ToUniversalTime().ToString('o') }; if ($app -and $m -match 'Kernel_[0-9a-fA-F]+_[0-9a-fA-F]+_[0-9a-fA-F]+_([0-9a-fA-F-]{36})') { $key = 'WER:' + $Matches[1] }; [pscustomobject]@{ LogName = $_.LogName; RecordId = $_.RecordId; Id = $_.Id; ProviderName = $_.ProviderName; TimeCreated = $_.TimeCreated.ToUniversalTime().ToString('o'); Message = $m.Substring(0, [Math]::Min($m.Length, 600)); EventName = $(if ($app -and $p.Count -gt 5) { [string]$p[2].Value }); P1 = $(if ($app -and $p.Count -gt 5) { [string]$p[5].Value }); Data0 = $(if ($_.Id -eq 1001 -and -not $app -and $p.Count -gt 0) { [string]$p[0].Value }); Key = $key; DumpTime = $dump } } | Where-Object { $_.LogName -ne 'Application' -or -not $_.P1 -or @('141', '117', '116') -contains ($_.P1 -replace '^0+', '') })`,
        "$rows = @($rows | Group-Object { if ($_.Key) { $_.Key } else { [string]$_.LogName + ':' + [string]$_.RecordId } } | ForEach-Object { $_.Group[0] })",
        "ConvertTo-Json -InputObject ([pscustomobject]@{ rows = $rows; last = $last }) -Compress -Depth 4",
    ].join("; ");
};

const MarkSchema = z.number().int().nonnegative().optional().catch(undefined);
const AnswerSchema = z.object({
    rows: z.unknown(),
    last: z.object({ System: MarkSchema, Application: MarkSchema }).catch({}),
});

export interface CrashAnswer {
    readonly events: HostCrashEvent[];
    readonly last: CrashMarks;
}

// The script's answer: its events (crashEventsFrom) and the newest record each log answered with. Output that is not
// the answer is no events and no marks, so the next query asks the whole day again. Pure.
export const crashAnswerFrom = (json: string): CrashAnswer => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json.trim());
    } catch {
        // allow(silent-catch): output that is not JSON (a PowerShell warning) reads as no events; the next refresh asks again
        return { events: [], last: {} };
    }
    const answer = AnswerSchema.safeParse(parsed);
    if (!answer.success) {
        return { events: [], last: {} };
    }
    const rows = answer.data.rows ?? [];
    return { events: crashEventsFrom(JSON.stringify(rows)), last: answer.data.last };
};

// PowerShell's -EncodedCommand (UTF-16LE, base64): the script's quotes reach it untouched by any command-line quoting.
const encodedCommand = (script: string): string => Buffer.from(script, "utf16le").toString("base64");

// Reading the logs takes a second or two; the deadline is for an event log service that hangs.
const QUERY_TIMEOUT_MS = 30_000;

const queryWindows = async (after: CrashMarks): Promise<CrashAnswer> => {
    const { stdout } = await execBounded("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand(crashScript(HOST_CRASH_LOOKBACK_MS, after))], {
        timeoutMs: QUERY_TIMEOUT_MS,
        maxOutput: 512 * 1024,
    });
    return crashAnswerFrom(stdout);
};

// (2026-11-24) At most one query this often, from once a minute: a heartbeat comes every 30 s from each linked sandbox,
// and each query was a PowerShell. A GPU reset that matters takes the sandbox down with it, and is read at the
// reconnect's first heartbeat after the agent restarts, or within five minutes.
export const CRASH_REFRESH_MS = 5 * 60_000;
// How often the whole day is asked again rather than what came after the last record: a cleared log starts its records
// over, and a query from a mark past them would find nothing until this.
export const CRASH_REBASE_MS = 6 * 60 * 60_000;

export interface CrashWatch {
    // The events of the last day; asks again in the background once the last ask is CRASH_REFRESH_MS old, or at once
    // with `fresh`. Never throws and never waits.
    readonly current: (options?: { readonly fresh?: boolean }) => HostCrashEvent[];
}

interface CrashWatchDeps {
    readonly query: (after: CrashMarks) => Promise<CrashAnswer>;
    readonly log: (message: string) => void;
    readonly now?: () => number;
}

const newer = (held: number | undefined, answered: number | undefined): number | undefined =>
    held === undefined ? answered : answered === undefined ? held : Math.max(held, answered);

export const createCrashWatch = ({ query, log, now = Date.now }: CrashWatchDeps): CrashWatch => {
    // By id, the first sighting kept: a report WER logs again is the event it was.
    let events = new Map<string, HostCrashEvent>();
    let marks: CrashMarks = {};
    let askedAt = Number.NEGATIVE_INFINITY;
    let wholeAt = Number.NEGATIVE_INFINITY;
    let underway = false;
    // A failing query is said once, not on every refresh, and again only after one has worked.
    let failing = false;
    const refresh = (): void => {
        underway = true;
        askedAt = now();
        const whole = askedAt - wholeAt >= CRASH_REBASE_MS;
        void query(whole ? {} : marks)
            .then((answer) => {
                const since = now() - HOST_CRASH_LOOKBACK_MS;
                const kept = whole ? new Map<string, HostCrashEvent>() : events;
                for (const event of answer.events) {
                    if (!kept.has(event.id)) {
                        kept.set(event.id, event);
                    }
                }
                events = new Map(
                    [...kept]
                        .filter(([, event]) => Date.parse(event.at) >= since)
                        .toSorted(([, a], [, b]) => Date.parse(b.at) - Date.parse(a.at))
                        .slice(0, HOST_CRASHES_MAX),
                );
                marks = whole ? answer.last : { System: newer(marks.System, answer.last.System), Application: newer(marks.Application, answer.last.Application) };
                if (whole) {
                    wholeAt = askedAt;
                }
                failing = false;
            })
            .catch((error: Error) => {
                if (!failing) {
                    log(`reading Windows' event log for GPU resets and crashes failed (the last answer stands): ${errorMessage(error).split("\n")[0] ?? ""}`);
                }
                failing = true;
            })
            .finally(() => {
                underway = false;
            });
    };
    return {
        current: (options) => {
            if (!underway && (options?.fresh === true || now() - askedAt >= CRASH_REFRESH_MS)) {
                refresh();
            }
            const since = now() - HOST_CRASH_LOOKBACK_MS;
            return [...events.values()].filter((event) => Date.parse(event.at) >= since);
        },
    };
};

let windowsWatch: CrashWatch | undefined;

// What the heartbeat answers with: undefined anywhere but the Windows side (a distro's agent reads no Windows log), and
// on it the events of the last day, the first answer arriving a heartbeat after the agent starts.
export const windowsCrashEvents = (log: (message: string) => void): HostCrashEvent[] | undefined => {
    if (!WINDOWS_SIDE) {
        return undefined;
    }
    windowsWatch ??= createCrashWatch({ query: queryWindows, log });
    return windowsWatch.current();
};
