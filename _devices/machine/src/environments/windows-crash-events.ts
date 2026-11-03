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

// The script. Times go in as Unix ms, so no date format of the locale is parsed; a log with no matching event is no
// events, never an error. WER's Application 1001 is filtered to the display driver's live kernel events here, since it
// also carries every application crash on the machine, and to one row per report (crashEventOf says why), each with
// the time in its dump's name (`WATCHDOG-20261102-2030.dmp`, Windows' local time) and only the head of its message:
// a day of re-logged reports ran to 700 KB whole.
export const crashScript = (sinceMs: number): string =>
    [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        `$since = [DateTimeOffset]::FromUnixTimeMilliseconds(${Math.round(sinceMs)}).LocalDateTime`,
        "$found = @()",
        `foreach ($filter in @(@{ LogName = 'System'; Id = 41, 1001, 4101; StartTime = $since }, @{ LogName = 'Application'; ProviderName = '${WER}'; Id = 1001; StartTime = $since })) { try { $found += @(Get-WinEvent -FilterHashtable $filter -ErrorAction Stop) } catch { if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { throw } } }`,
        `$rows = @($found | Where-Object { $_.LogName -ne 'Application' -or ([string]$_.Message) -match 'LiveKernelEvent' } | ForEach-Object { $p = $_.Properties; $m = [string]$_.Message; $app = $_.LogName -eq 'Application'; $dump = ''; $key = ''; if ($app -and $m -match 'WATCHDOG-([0-9]{8}-[0-9]{4})') { $dump = [datetime]::ParseExact($Matches[1], 'yyyyMMdd-HHmm', [Globalization.CultureInfo]::InvariantCulture).ToUniversalTime().ToString('o') }; if ($app -and $m -match 'Kernel_[0-9a-fA-F]+_[0-9a-fA-F]+_[0-9a-fA-F]+_([0-9a-fA-F-]{36})') { $key = 'WER:' + $Matches[1] }; [pscustomobject]@{ LogName = $_.LogName; RecordId = $_.RecordId; Id = $_.Id; ProviderName = $_.ProviderName; TimeCreated = $_.TimeCreated.ToUniversalTime().ToString('o'); Message = $m.Substring(0, [Math]::Min($m.Length, 600)); EventName = $(if ($app -and $p.Count -gt 5) { [string]$p[2].Value }); P1 = $(if ($app -and $p.Count -gt 5) { [string]$p[5].Value }); Data0 = $(if ($_.Id -eq 1001 -and -not $app -and $p.Count -gt 0) { [string]$p[0].Value }); Key = $key; DumpTime = $dump } } | Where-Object { $_.LogName -ne 'Application' -or -not $_.P1 -or @('141', '117', '116') -contains ($_.P1 -replace '^0+', '') })`,
        "$rows = @($rows | Group-Object { if ($_.Key) { $_.Key } else { [string]$_.LogName + ':' + [string]$_.RecordId } } | ForEach-Object { $_.Group[0] })",
        "ConvertTo-Json -InputObject $rows -Compress -Depth 3",
    ].join("; ");

// PowerShell's -EncodedCommand (UTF-16LE, base64): the script's quotes reach it untouched by any command-line quoting.
const encodedCommand = (script: string): string => Buffer.from(script, "utf16le").toString("base64");

// Reading the logs takes a second or two; the deadline is for an event log service that hangs.
const QUERY_TIMEOUT_MS = 30_000;

const queryWindows = async (now: number): Promise<HostCrashEvent[]> => {
    const { stdout } = await execBounded("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand(crashScript(now - HOST_CRASH_LOOKBACK_MS))], {
        timeoutMs: QUERY_TIMEOUT_MS,
        maxOutput: 512 * 1024,
    });
    return crashEventsFrom(stdout);
};

// At most one query this often: a heartbeat comes every 30 s from each linked sandbox, and a reset is news within a minute.
export const CRASH_REFRESH_MS = 60_000;

export interface CrashWatch {
    // The last answer, those of the last day only; asks again in the background once it is CRASH_REFRESH_MS old. Never
    // throws and never waits.
    readonly current: () => HostCrashEvent[];
}

interface CrashWatchDeps {
    readonly query: (now: number) => Promise<HostCrashEvent[]>;
    readonly log: (message: string) => void;
    readonly now?: () => number;
}

export const createCrashWatch = ({ query, log, now = Date.now }: CrashWatchDeps): CrashWatch => {
    let events: HostCrashEvent[] = [];
    let askedAt = Number.NEGATIVE_INFINITY;
    let underway = false;
    // A failing query is said once, not on every refresh, and again only after one has worked.
    let failing = false;
    const refresh = (): void => {
        underway = true;
        askedAt = now();
        void query(askedAt)
            .then((answer) => {
                events = answer;
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
        current: () => {
            if (!underway && now() - askedAt >= CRASH_REFRESH_MS) {
                refresh();
            }
            const since = now() - HOST_CRASH_LOOKBACK_MS;
            return events.filter((event) => Date.parse(event.at) >= since);
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
