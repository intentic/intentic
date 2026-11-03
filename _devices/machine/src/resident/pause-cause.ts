import { readFile } from "node:fs/promises";
import { totalmem } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { execBounded } from "@intentic/base/process";
import { errorMessage } from "@intentic/base/errors";
import { z } from "zod";

/* WAS THAT PAUSE A SLEEP OR A FREEZE (2026-11-02). The watchdog's Worker sees the agent paused when its own checks come
   back far apart or the wall clock runs ahead, and says so at once (watchdog.ts). It cannot say why: Windows' monotonic
   clock keeps counting through a sleep, so 43 s of it gone is a laptop lid closed or a machine paging itself to a
   standstill, and the clocks alike. On 2026-11-02 a PC with 1 GB free logged "suspected sleep/resume" for what was a
   freeze, and the line sent the diagnosis the wrong way. So the main thread, told of the pause, asks the machine:
   Windows writes every sleep and wake to its System log, and memory read just after says whether paging was the cause.
   Elsewhere the monotonic clock stops in a sleep, so the clocks already tell, and memory is read the same. All of it is
   bounded, and none of it throws: the answer is one more log line, and an unanswered question is said as one. */

// What the Worker posts when it sees a pause: how long (as watchdog.ts's line says it), the wall-clock times of the
// last check before it and the one that saw it, and whether the monotonic clock was held too (`held`) or only the wall
// clock ran ahead. Parsed on the main thread, since a Worker's message is whatever it sent.
export const pauseReport = z.object({ kind: z.literal("paused"), seconds: z.number(), from: z.number(), to: z.number(), held: z.boolean() });
export type PauseReport = z.infer<typeof pauseReport>;

// A sleep or a wake Windows logged, at a wall-clock time in ms. Kernel-Power 42 and 506 are entering sleep and Modern
// Standby; 107 and 507 coming back from them; Power-Troubleshooter 1 is the wake as the troubleshooter records it, its
// time the one closest to the real wake (Kernel-Power 107 is often stamped with the clock as it stood going down).
export interface PowerEvent {
    readonly kind: "sleep" | "wake";
    readonly at: number;
    // Power-Troubleshooter's wake, the one whose time is the wake's.
    readonly troubleshooter?: boolean;
}

// How far outside the pause a power event still counts: the 42 is written as the machine goes down, up to a check
// interval after the last check, and the wake events a little after it is back.
const POWER_EVENT_SLACK_MS = 60_000;

// Memory as read just after the pause; any part may be missing. `paging` is Windows' Pages/sec (hard faults, file and
// page file alike), `swapping` Linux's pages swapped in and out a second, `pressure` Linux's PSI "some" over a minute.
export interface MemoryReading {
    readonly freeMb: number | undefined;
    readonly totalMb: number | undefined;
    readonly paging: number | undefined;
    readonly swapping: number | undefined;
    readonly pressure: number | undefined;
}

export const NO_MEMORY: MemoryReading = { freeMb: undefined, totalMb: undefined, paging: undefined, swapping: undefined, pressure: undefined };

export type PauseVerdict =
    | { readonly kind: "sleep"; readonly sleptAt: number | undefined; readonly wokeAt: number | undefined }
    // Windows logged no sleep or wake around it, or (elsewhere) the clock that stops in a sleep kept counting.
    | { readonly kind: "freeze"; readonly why: "no-power-events" | "monotonic" }
    // Windows: only the wall clock moved, and no sleep was logged.
    | { readonly kind: "clock" }
    // Elsewhere: only the wall clock moved, which a sleep and a clock set forward both do.
    | { readonly kind: "sleep-or-clock" }
    | { readonly kind: "unknown"; readonly why: string };

// Which it was. `events` is undefined when the Windows event log could not be read (`why` says how). Pure.
export const classifyPause = (
    pause: PauseReport,
    windows: boolean,
    events: readonly PowerEvent[] | undefined,
    why = "no answer",
    slackMs = POWER_EVENT_SLACK_MS,
): PauseVerdict => {
    if (!windows) {
        return pause.held ? { kind: "freeze", why: "monotonic" } : { kind: "sleep-or-clock" };
    }
    if (events === undefined) {
        return { kind: "unknown", why: `the Windows event log did not answer (${why})` };
    }
    const inside = [...events].sort((a, b) => a.at - b.at).filter((event) => event.at >= pause.from - slackMs && event.at <= pause.to + slackMs);
    if (inside.length > 0) {
        // The first going down, and the last coming back, the troubleshooter's wake first, its time being the wake's.
        const down = inside.find((event) => event.kind === "sleep");
        const wakes = inside.filter((event) => event.kind === "wake");
        const wake = wakes.findLast((event) => event.troubleshooter === true) ?? wakes.at(-1);
        return { kind: "sleep", sleptAt: down?.at, wokeAt: wake?.at };
    }
    return pause.held ? { kind: "freeze", why: "no-power-events" } : { kind: "clock" };
};

const thousands = (value: number): string => String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// "; memory: 1,065 MB free of 32,405 MB, 2,300 pages/s paging", or nothing when nothing was read. Pure.
export const memoryPhrase = (memory: MemoryReading): string => {
    const parts = [
        ...(memory.freeMb === undefined ? [] : [`${thousands(memory.freeMb)} MB free${memory.totalMb === undefined ? "" : ` of ${thousands(memory.totalMb)} MB`}`]),
        ...(memory.paging === undefined ? [] : [`${thousands(memory.paging)} pages/s paging`]),
        ...(memory.swapping === undefined ? [] : [`${thousands(memory.swapping)} pages/s swapped`]),
        ...(memory.pressure === undefined ? [] : [`memory pressure ${memory.pressure}% over the last minute`]),
    ];
    return parts.length === 0 ? "" : `; memory: ${parts.join(", ")}`;
};

const verdictText = (verdict: PauseVerdict): string => {
    switch (verdict.kind) {
        case "sleep": {
            const went = verdict.sleptAt === undefined ? undefined : `went to sleep at ${new Date(verdict.sleptAt).toISOString()}`;
            const woke = verdict.wokeAt === undefined ? undefined : `woke at ${new Date(verdict.wokeAt).toISOString()}`;
            return `was a sleep: Windows ${[went, woke].filter((part) => part !== undefined).join(" and ")}`;
        }
        case "freeze":
            return verdict.why === "no-power-events"
                ? "was not a sleep (Windows logged no sleep or wake around it): a freeze, the machine or this process held up"
                : "was not a sleep (the monotonic clock, which stops while this machine sleeps, kept counting): a freeze, the machine, its VM or this process held up";
        case "clock":
            return "was the clock set forward, not a sleep or a freeze (only the wall clock moved, and Windows logged no sleep or wake)";
        case "sleep-or-clock":
            return "was a sleep or the clock set forward, not a freeze (only the wall clock moved; the monotonic one stops while this machine sleeps)";
        case "unknown":
            return `could not be told a sleep or a freeze: ${verdict.why}`;
    }
};

// The line that follows the watchdog's pause line, in the same style. Pure.
export const pauseCauseLine = (pause: PauseReport, verdict: PauseVerdict, memory: MemoryReading, at: Date): string =>
    `[${at.toISOString()}] watchdog: the ${pause.seconds} s pause from ${new Date(pause.from).toISOString()} ${verdictText(verdict)}${memoryPhrase(memory)}\n`;

// ---- Windows: one PowerShell for both questions, its start being most of the cost on a machine that is paging.

const PROVIDERS = "'Microsoft-Windows-Kernel-Power', 'Microsoft-Windows-Power-Troubleshooter'";

// The script, its answers one tagged line each: "memory|free MB|pages/s", then "event|provider|id|ISO" per event or
// "events|none", or "<part>-error|message". Pages/sec from two raw samples a second apart (the formatted class's first
// read of a rate is often 0), and from the CIM classes, whose names are the same on every Windows locale where
// Get-Counter's are translated. The event log is read a few seconds later, so a wake written just after the agent came
// back is in it. Times go in as Unix ms, so no date format of the locale is parsed.
const windowsScript = (from: number, to: number): string =>
    [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        "try { $a = Get-CimInstance Win32_PerfRawData_PerfOS_Memory; Start-Sleep -Seconds 1; $b = Get-CimInstance Win32_PerfRawData_PerfOS_Memory; $t = $b.Timestamp_PerfTime - $a.Timestamp_PerfTime; \"memory|$($b.AvailableMBytes)|$(if ($t -gt 0) { [math]::Round(($b.PagesPersec - $a.PagesPersec) * $b.Frequency_PerfTime / $t) })\" } catch { \"memory-error|$($_.Exception.Message)\" }",
        "Start-Sleep -Seconds 4",
        `try { Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = ${PROVIDERS}; Id = 1, 42, 107, 506, 507; StartTime = [DateTimeOffset]::FromUnixTimeMilliseconds(${Math.round(from)}).LocalDateTime; EndTime = [DateTimeOffset]::FromUnixTimeMilliseconds(${Math.round(to)}).LocalDateTime } | ForEach-Object { "event|$($_.ProviderName)|$($_.Id)|$($_.TimeCreated.ToUniversalTime().ToString('o'))" } } catch { if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { 'events|none' } else { "events-error|$($_.Exception.Message)" } }`,
    ].join("; ");

// PowerShell's -EncodedCommand (UTF-16LE, base64): the script's quotes reach it untouched by any command-line quoting.
const encodedCommand = (script: string): string => Buffer.from(script, "utf16le").toString("base64");

const powerKind = (provider: string, id: number): PowerEvent | undefined => {
    if (provider === "Microsoft-Windows-Kernel-Power") {
        if (id === 42 || id === 506) {
            return { kind: "sleep", at: 0 };
        }
        if (id === 107 || id === 507) {
            return { kind: "wake", at: 0 };
        }
    }
    return provider === "Microsoft-Windows-Power-Troubleshooter" && id === 1 ? { kind: "wake", at: 0, troubleshooter: true } : undefined;
};

const number = (text: string | undefined): number | undefined => {
    const value = text === undefined || text.trim() === "" ? Number.NaN : Number(text);
    return Number.isFinite(value) ? value : undefined;
};

export interface WindowsAnswer {
    // Undefined when the log was not read; `why` then says how.
    readonly events: PowerEvent[] | undefined;
    readonly why: string;
    readonly memory: MemoryReading;
}

const memoryLine = (rest: readonly string[]): MemoryReading => ({ ...NO_MEMORY, freeMb: number(rest[0]), paging: number(rest[1]) });

const eventLine = (rest: readonly string[]): PowerEvent | undefined => {
    const kind = powerKind(rest[0] ?? "", Number(rest[1]));
    const at = Date.parse(rest[2] ?? "");
    return kind === undefined || !Number.isFinite(at) ? undefined : { ...kind, at };
};

// What the script answered. Pure.
export const parseWindowsAnswer = (stdout: string): WindowsAnswer => {
    const events: PowerEvent[] = [];
    let read = false;
    let why = "no answer";
    let memory = NO_MEMORY;
    for (const line of stdout.split(/\r?\n/)) {
        const [tag = "", ...rest] = line.trim().split("|");
        const event = tag === "event" ? eventLine(rest) : undefined;
        memory = tag === "memory" ? memoryLine(rest) : memory;
        read ||= tag === "events" || tag === "event";
        why = tag === "events-error" ? rest.join("|").trim() || why : why;
        if (event !== undefined) {
            events.push(event);
        }
    }
    return { events: read ? events : undefined, why, memory };
};

// ---- Linux: /proc. Pure parsers, then the reads.

export const parseMeminfoAvailableMb = (text: string): number | undefined => {
    const kb = /^MemAvailable:\s+(\d+)\s*kB/m.exec(text)?.[1];
    return kb === undefined ? undefined : Math.round(Number(kb) / 1024);
};

export const parseSwapPages = (vmstat: string): number | undefined => {
    const pin = /^pswpin\s+(\d+)/m.exec(vmstat)?.[1];
    const pout = /^pswpout\s+(\d+)/m.exec(vmstat)?.[1];
    return pin === undefined || pout === undefined ? undefined : Number(pin) + Number(pout);
};

// PSI's "some avg60": the share of the last minute some task waited on memory.
export const parsePressure = (psi: string): number | undefined => number(/^some\s.*\bavg60=([\d.]+)/m.exec(psi)?.[1]);

const readOr = (path: string): Promise<string> =>
    // allow(silent-catch): a file this kernel does not have (PSI is optional) is a reading left out of the line
    readFile(path, "utf8").catch(() => "");

const linuxMemory = async (): Promise<MemoryReading> => {
    const before = parseSwapPages(await readOr("/proc/vmstat"));
    await sleep(1_000);
    const after = parseSwapPages(await readOr("/proc/vmstat"));
    const freeMb = parseMeminfoAvailableMb(await readOr("/proc/meminfo"));
    const pressure = parsePressure(await readOr("/proc/pressure/memory"));
    return { ...NO_MEMORY, freeMb, swapping: before === undefined || after === undefined ? undefined : Math.max(0, after - before), pressure };
};

// How long the whole Windows question may take: PowerShell's start on a machine paging hard is most of it.
const WINDOWS_TIMEOUT_MS = 60_000;

// The machine's whole memory, said only beside a free figure.
const withTotal = (memory: MemoryReading, totalMb: number): MemoryReading => (memory.freeMb === undefined ? memory : { ...memory, totalMb });

// The follow-up line for a pause: never throws, and ends within about a minute.
export const explainPause = async (pause: PauseReport, platform: NodeJS.Platform = process.platform): Promise<string> => {
    const totalMb = Math.round(totalmem() / 1024 / 1024);
    try {
        if (platform === "win32") {
            let answer: WindowsAnswer;
            try {
                const { stdout } = await execBounded(
                    "powershell.exe",
                    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand(windowsScript(pause.from - POWER_EVENT_SLACK_MS, pause.to + POWER_EVENT_SLACK_MS))],
                    { timeoutMs: WINDOWS_TIMEOUT_MS, maxOutput: 64 * 1024 },
                );
                answer = parseWindowsAnswer(stdout);
            } catch (error) {
                answer = { events: undefined, why: errorMessage(error).split("\n")[0] ?? "PowerShell failed", memory: NO_MEMORY };
            }
            return pauseCauseLine(pause, classifyPause(pause, true, answer.events, answer.why), withTotal(answer.memory, totalMb), new Date());
        }
        // macOS's free figure leaves out the memory it would hand back at once, and reads as always short: left out.
        const memory = platform === "linux" ? await linuxMemory() : NO_MEMORY;
        return pauseCauseLine(pause, classifyPause(pause, false, undefined), withTotal(memory, totalMb), new Date());
    } catch (error) {
        return pauseCauseLine(pause, { kind: "unknown", why: errorMessage(error) }, NO_MEMORY, new Date());
    }
};
