import { execBounded } from "@intentic/base/process";
import { z } from "zod";

/* WHAT WINDOWS' POWER PLANS SAY ABOUT WORK LEFT RUNNING (2026-11-22). rog's plan slept it five hours after the last
   keypress and both sandboxes on it froze through the night's booked sends (windows-findings.ts says what each value means).
   This reads the four settings that decide it, from EVERY power plan, since a vendor's own tool switches plans by
   itself (rog's ASUS software moves between Performance, Balanced, Silent and Turbo), and the facts around them: Modern
   Standby, a battery, a lid, Windows Update's active hours.

   One PowerShell, one JSON answer, nothing in it read from translated text. `powercfg` prints its labels in the
   machine's language (owners run Polish and German Windows), so of its output only GUIDs and the `0x…` numbers are
   read: `powercfg /qh <plan> <subgroup> <setting>` ends, in every language, with the AC index and then the DC index as
   the last two `0x` numbers (`/qh` and not `/q`, since a vendor may hide a setting from the plan's own page). A setting
   a plan does not have makes powercfg exit 1, and reads as null, never as an error. Modern Standby, the battery and the
   lid come from one CallNtPowerInformation(SystemPowerCapabilities) through Add-Type, which also reads each plan's
   name as UTF-16 (PowerReadFriendlyName), so a Polish plan name is never decoded through a console code page; where
   Add-Type is refused (a locked-down PC's constrained language mode) the names are powercfg's and the battery is
   Win32_Battery's, and Modern Standby and the lid are unknown. The answer is written with every character past ASCII
   escaped, so it reads the same whatever code page PowerShell writes its output in. */

// The settings read, by Windows' own GUIDs (powercfg's aliases in the comments). Each is a subgroup and a setting.
export const POWER_SETTINGS = {
    // STANDBYIDLE, "Sleep after": seconds without input, 0 = never.
    standbyIdle: { sub: "238c9fa8-0aad-41ed-83f4-97be242c8f20", setting: "29f6c1db-86da-48c5-9fdb-f2b67b1f44da" },
    // HIBERNATEIDLE, "Hibernate after": seconds, 0 = never (and anything from 0x7FFFFFFF up, which rog's Balanced plan
    // holds on battery: 68 years is never).
    hibernateIdle: { sub: "238c9fa8-0aad-41ed-83f4-97be242c8f20", setting: "9d7815a6-7ee4-497e-8888-515a05f02364" },
    // LIDACTION, "Lid close action": 0 do nothing, 1 sleep, 2 hibernate, 3 shut down.
    lidAction: { sub: "4f971e89-eebd-4455-a8de-9e59040e7347", setting: "5ca83367-6e45-459f-a27b-476b1d01c936" },
    // CONNECTIVITYINSTANDBY, "Networking connectivity in Standby": 0 disabled (the network is cut in Modern Standby),
    // 1 enabled, 2 managed by Windows.
    standbyConnectivity: { sub: "fea3413e-7e05-4911-9a71-700331f1c294", setting: "f15576e8-98b7-4186-b944-eafa664402d9" },
} as const;

export type PowerSettingKey = keyof typeof POWER_SETTINGS;
export const POWER_SETTING_KEYS = ["standbyIdle", "hibernateIdle", "lidAction", "standbyConnectivity"] as const satisfies readonly PowerSettingKey[];

// One setting in one plan: its index on mains power (ac) and on battery (dc).
export interface IndexPair {
    readonly ac: number;
    readonly dc: number;
}

export interface PlanReading {
    readonly guid: string;
    readonly name: string;
    readonly active: boolean;
    // Null where the plan does not have the setting at all.
    readonly settings: Readonly<Record<PowerSettingKey, IndexPair | null>>;
}

export interface WindowsPowerReading {
    readonly at: number;
    readonly plans: readonly PlanReading[];
    // Undefined where it could not be read (Add-Type refused).
    readonly modernStandby: boolean | undefined;
    readonly battery: boolean | undefined;
    readonly lid: boolean | undefined;
    // Windows Update's active hours, local hours 0-23; undefined where they are not set.
    readonly activeHours: { readonly start: number; readonly end: number } | undefined;
    readonly utcOffsetMinutes: number;
}

// An idle timeout as seconds that act, 0 where it never does: 0 itself, and anything from 0x7FFFFFFF up. Pure.
export const idleSeconds = (value: number): number => (value <= 0 || value >= 0x7f_ff_ff_ff ? 0 : value);

const GUID = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i;

// The C# the script loads: the system's power capabilities as their raw 76 bytes (SYSTEM_POWER_CAPABILITIES; the
// offsets are read in capabilitiesFrom) and a plan's name as Windows stores it.
const NATIVE = `using System; using System.Runtime.InteropServices;
public static class IntenticPower {
  [DllImport("powrprof.dll")] static extern uint CallNtPowerInformation(int level, IntPtr input, int inputLength, byte[] output, int outputLength);
  [DllImport("powrprof.dll")] static extern uint PowerReadFriendlyName(IntPtr root, ref Guid scheme, IntPtr subgroup, IntPtr setting, byte[] buffer, ref uint size);
  public static byte[] Capabilities() { byte[] b = new byte[76]; return CallNtPowerInformation(4, IntPtr.Zero, 0, b, b.Length) == 0 ? b : null; }
  public static string Name(string scheme) { Guid g = new Guid(scheme); byte[] b = new byte[2048]; uint size = (uint)b.Length; if (PowerReadFriendlyName(IntPtr.Zero, ref g, IntPtr.Zero, IntPtr.Zero, b, ref size) != 0) return null; return System.Text.Encoding.Unicode.GetString(b, 0, (int)Math.Min(size, (uint)b.Length)).TrimEnd('\\0'); }
}`;

// The script: powercfg for the plans and every setting of each, the native capabilities and names, the active hours
// from the registry, the local offset from UTC. Its lines are joined with newlines (the C# is a here-string).
export const windowsPowerScript = (): string =>
    [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        `$settings = @(${POWER_SETTING_KEYS.map((key) => `@{ sub = '${POWER_SETTINGS[key].sub}'; setting = '${POWER_SETTINGS[key].setting}' }`).join(", ")})`,
        "$list = (powercfg.exe /list) -join \"`n\"",
        `$plans = @([regex]::Matches($list, '${GUID.source}', 'IgnoreCase') | ForEach-Object { $_.Value.ToLowerInvariant() } | Select-Object -Unique)`,
        "$queries = @(foreach ($plan in $plans) { foreach ($s in $settings) { $text = (powercfg.exe /qh $plan $s.sub $s.setting) -join \"`n\"; [pscustomobject]@{ plan = $plan; setting = $s.setting; code = $LASTEXITCODE; text = $text } } })",
        "$capabilities = $null; $names = @{}; $nativeError = $null",
        "try {",
        "Add-Type -TypeDefinition @'",
        NATIVE,
        "'@",
        "$bytes = [IntenticPower]::Capabilities(); if ($bytes) { $capabilities = [Convert]::ToBase64String($bytes) }",
        "foreach ($plan in $plans) { $name = [IntenticPower]::Name($plan); if ($name) { $names[$plan] = $name } }",
        "} catch { $nativeError = $_.Exception.Message }",
        "$battery = $null; if (-not $capabilities) { try { $battery = @(Get-CimInstance -ClassName Win32_Battery).Count -gt 0 } catch { $battery = $null } }",
        "$hoursStart = $null; $hoursEnd = $null",
        "try { $ux = Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings'; $hoursStart = $ux.ActiveHoursStart; $hoursEnd = $ux.ActiveHoursEnd } catch { $hoursStart = $null; $hoursEnd = $null }",
        "$offset = [int][TimeZoneInfo]::Local.GetUtcOffset([DateTime]::Now).TotalMinutes",
        "$json = [pscustomobject]@{ list = $list; queries = $queries; names = $names; capabilities = $capabilities; nativeError = $nativeError; battery = $battery; activeHoursStart = $hoursStart; activeHoursEnd = $hoursEnd; utcOffsetMinutes = $offset } | ConvertTo-Json -Compress -Depth 4",
        "[regex]::Replace($json, '[^\\x00-\\x7e]', { param($m) '\\u{0:x4}' -f [int][char]$m.Value })",
    ].join("\n");

const QuerySchema = z.object({
    plan: z.string(),
    setting: z.string(),
    code: z.number().nullable().catch(null),
    text: z.string().nullable().catch(null),
});
type Query = z.infer<typeof QuerySchema>;

// What the script prints. A field PowerShell may leave null or write oddly reads as unknown, never as a failed read;
// only the plan list and the offset are required.
export const WindowsAnswerSchema = z.object({
    list: z.string(),
    // ConvertTo-Json writes a one-element array as itself in PowerShell 5.1 only when it is not a property; read both.
    queries: z.preprocess((value) => (Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]), z.array(QuerySchema)),
    names: z.record(z.string(), z.string()).nullable().catch(null),
    capabilities: z.string().nullable().catch(null),
    nativeError: z.string().nullable().catch(null),
    battery: z.boolean().nullable().catch(null),
    activeHoursStart: z.number().int().min(0).max(23).nullable().catch(null),
    activeHoursEnd: z.number().int().min(0).max(23).nullable().catch(null),
    utcOffsetMinutes: z.number().int(),
});
export type WindowsAnswer = z.infer<typeof WindowsAnswerSchema>;

// One plan as `powercfg /list` names it.
export interface ListedPlan {
    readonly guid: string;
    readonly name: string;
    readonly active: boolean;
}

// The plans `powercfg /list` names, in its order: each line holding a GUID is one plan, its name in the brackets after
// the GUID, the active one marked by a trailing `*`. Only the GUID, the brackets and the star are read, which no
// language changes. Pure.
export const planListFrom = (list: string): ListedPlan[] => {
    const plans: ListedPlan[] = [];
    for (const line of list.split(/\r?\n/)) {
        const guid = GUID.exec(line);
        if (guid === null || plans.some((plan) => plan.guid === guid[0].toLowerCase())) {
            continue;
        }
        const after = line.slice(guid.index + guid[0].length);
        const name = /\((.*)\)/.exec(after)?.[1]?.trim() ?? "";
        plans.push({ guid: guid[0].toLowerCase(), name: name === "" ? guid[0].toLowerCase() : name, active: /\*\s*$/.test(after) });
    }
    return plans;
};

// One `powercfg /qh <plan> <sub> <setting>` answer as its AC and DC index: the last two `0x` numbers, in every language.
// Null where powercfg failed (a setting the plan does not have), where the answer is not about that setting, or where it
// holds fewer than two numbers. Pure.
export const indexPairFrom = (query: Pick<Query, "code" | "text">, setting: string): IndexPair | null => {
    const text = query.text ?? "";
    if (query.code !== 0 || !text.toLowerCase().includes(setting.toLowerCase())) {
        return null;
    }
    const numbers = [...text.matchAll(/0x([0-9a-f]+)/gi)].map((match) => Number.parseInt(match[1] ?? "", 16));
    const [ac, dc] = numbers.slice(-2);
    return numbers.length < 2 || ac === undefined || dc === undefined || !Number.isFinite(ac) || !Number.isFinite(dc) ? null : { ac, dc };
};

// What the native read says about the computer itself; each undefined where it was not read.
export interface PowerCapabilities {
    readonly lid: boolean | undefined;
    readonly modernStandby: boolean | undefined;
    readonly battery: boolean | undefined;
}

// SYSTEM_POWER_CAPABILITIES' bytes as the three facts read from it: LidPresent (byte 2), AoAc, Modern Standby (byte 20),
// and SystemBatteriesPresent (byte 30). Undefined for each where there are no bytes, or too few. Pure.
export const capabilitiesFrom = (base64: string | null): PowerCapabilities => {
    const bytes = base64 === null ? undefined : Buffer.from(base64, "base64");
    if (bytes === undefined || bytes.length < 31) {
        return { lid: undefined, modernStandby: undefined, battery: undefined };
    }
    return { lid: bytes[2] !== 0, modernStandby: bytes[20] !== 0, battery: bytes[30] !== 0 };
};

// The script's answer as a reading: every plan with each of its four settings (null where absent). Pure.
export const windowsReadingFrom = (answer: WindowsAnswer, at: number): WindowsPowerReading => {
    const capabilities = capabilitiesFrom(answer.capabilities);
    const plans = planListFrom(answer.list).map((plan): PlanReading => {
        const pair = (key: PowerSettingKey): IndexPair | null => {
            const { setting } = POWER_SETTINGS[key];
            const query = answer.queries.find((entry) => entry.plan.toLowerCase() === plan.guid && entry.setting.toLowerCase() === setting);
            return query === undefined ? null : indexPairFrom(query, setting);
        };
        return {
            guid: plan.guid,
            name: answer.names?.[plan.guid] ?? plan.name,
            active: plan.active,
            settings: { standbyIdle: pair("standbyIdle"), hibernateIdle: pair("hibernateIdle"), lidAction: pair("lidAction"), standbyConnectivity: pair("standbyConnectivity") },
        };
    });
    const hours = answer.activeHoursStart !== null && answer.activeHoursEnd !== null ? { start: answer.activeHoursStart, end: answer.activeHoursEnd } : undefined;
    return {
        at,
        plans,
        modernStandby: capabilities.modernStandby,
        battery: capabilities.battery ?? answer.battery ?? undefined,
        lid: capabilities.lid,
        activeHours: hours,
        utcOffsetMinutes: answer.utcOffsetMinutes,
    };
};

// PowerShell's -EncodedCommand (UTF-16LE, base64): the script's quotes reach it untouched by any command-line quoting.
export const encodedCommand = (script: string): string => Buffer.from(script, "utf16le").toString("base64");

// The read takes under a second on rog (16 powercfg queries, ~60 ms, and Add-Type's compile, ~300 ms); the deadline is
// for a machine paging itself to a standstill.
const READ_TIMEOUT_MS = 30_000;

// Reads it, on Windows' own side only. Throws when PowerShell fails or answers something that is not the shape above.
export const readWindowsPower = async (now: () => number = Date.now): Promise<WindowsPowerReading> => {
    const { stdout } = await execBounded("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand(windowsPowerScript())], {
        timeoutMs: READ_TIMEOUT_MS,
        maxOutput: 256 * 1024,
    });
    const answer = WindowsAnswerSchema.parse(JSON.parse(stdout.trim()));
    return windowsReadingFrom(answer, now());
};
