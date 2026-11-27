import { mkdir, writeFile } from "node:fs/promises";
import { execBounded } from "@intentic/base/process";
import { UPDATE_PAUSE_MAX_MS } from "@intentic/sandbox-contract/schemas/host-power";
import { baseDir } from "../config.js";
import { powerChangedPath } from "./apply.js";
import { encodedCommand } from "./windows-reading.js";

/* `power pause-updates --until <when>` (2026-11-27): Windows Update paused until after work booked on this PC, the
   owner's yes on the sandbox's host-power card (the `update-pause` op). Windows Update restarts a PC outside its active
   hours, which hold at most 18 hours, so on rog (active 08:00 to 02:00) a restart could still come between 02:00 and
   08:00, and work booked for 05:00 waited for somebody to sign in.

   The pause is the one Windows' own Settings page sets: the six values under HKLM\SOFTWARE\Microsoft\WindowsUpdate\UX\
   Settings, start and end for updates as a whole, for feature updates and for quality updates, as `yyyy-MM-ddTHH:mm:ssZ`
   in UTC. That key lets a signed-in user set values (BUILTIN\Users holds SetValue on it on rog, checked 2026-11-27), so no
   prompt is raised; where it does not, the run fails with Windows' own refusal and nothing is half-written that matters,
   since Windows reads the end alone. A pause already reaching past `until` is left as it is: this never shortens one.
   Windows lets updates be paused for five weeks at most, and so does this.

   Then `UsoClient RefreshSettings` asks the update orchestrator to read them now rather than at its next pass, as the
   Settings page has it do. Checked on rog 2026-11-27, unelevated: the six values written, the refresh asked, and within
   half a minute the orchestrator's own state (HKLM\...\WindowsUpdate\UpdatePolicy\Settings) read PausedFeatureStatus 1
   and PausedQualityStatus 1, dated at the pause's start. The refresh also runs a scan, which finds updates and leaves
   them for after the pause. */

const UX_SETTINGS = "HKLM:\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings";

// Windows' own spelling of a moment in these values: UTC to the second, with a Z. Pure.
export const windowsUpdateTime = (at: number): string => `${new Date(Math.floor(at / 1_000) * 1_000).toISOString().slice(0, 19)}Z`;

// Each value, start or end, as Windows' Settings page writes them.
const STARTS = ["PauseUpdatesStartTime", "PauseFeatureUpdatesStartTime", "PauseQualityUpdatesStartTime"] as const;
const ENDS = ["PauseUpdatesExpiryTime", "PauseFeatureUpdatesEndTime", "PauseQualityUpdatesEndTime"] as const;

/** What a pause until `until` writes, read at `now`, over a pause that already ends at `current`; none where it already reaches. Pure. */
export const pauseWrites = (now: number, until: number, current: number | undefined): { readonly name: string; readonly value: string }[] => {
    if (until <= now) {
        throw new Error(`The pause would end at ${new Date(until).toISOString()}, which has already passed: nothing was changed.`);
    }
    if (until - now > UPDATE_PAUSE_MAX_MS) {
        throw new Error(`Windows pauses updates for five weeks at most, and ${new Date(until).toISOString()} is further off: nothing was changed.`);
    }
    if (current !== undefined && current >= until) {
        return [];
    }
    // A pause still running keeps its start, so Windows' own count of how long updates have been held stays true.
    const start = current !== undefined && current > now ? undefined : windowsUpdateTime(now);
    return [
        ...(start === undefined ? [] : STARTS.map((name) => ({ name, value: start }))),
        ...ENDS.map((name) => ({ name, value: windowsUpdateTime(until) })),
    ];
};

// A PowerShell single-quoted literal. Pure.
const psLiteral = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/** The script that writes them, as string values (REG_SZ), as Settings does, then has the orchestrator read them. Pure. */
export const pauseScript = (writes: readonly { readonly name: string; readonly value: string }[]): string =>
    [
        "$ErrorActionPreference = 'Stop'",
        ...writes.map((write) => `Set-ItemProperty -LiteralPath ${psLiteral(UX_SETTINGS)} -Name ${psLiteral(write.name)} -Value ${psLiteral(write.value)} -Type String`),
        // A refresh that cannot run leaves the pause to the orchestrator's next pass: written is what this run promises.
        "try { Start-Process -FilePath (Join-Path $env:WINDIR 'System32\\UsoClient.exe') -ArgumentList 'RefreshSettings' -WindowStyle Hidden -Wait } catch { Write-Output \"Windows Update takes the pause at its next pass: $($_.Exception.Message)\" }",
    ].join("\n");

export interface PauseIo {
    readonly now: () => number;
    // When the pause in force now ends, undefined where none is.
    readonly current: () => Promise<number | undefined>;
    readonly write: (script: string) => Promise<void>;
    readonly changed: () => Promise<void>;
}

export const realPauseIo = (current: () => Promise<number | undefined>): PauseIo => ({
    now: Date.now,
    current,
    write: async (script) => {
        await execBounded("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand(script)], { timeoutMs: 30_000 });
    },
    changed: async () => {
        await mkdir(baseDir, { recursive: true });
        await writeFile(powerChangedPath, `${new Date().toISOString()}\n`);
    },
});

export type PauseOutcome = { readonly kind: "already"; readonly until: number } | { readonly kind: "paused"; readonly until: number };

/** Pauses Windows Update until `until`, unless a pause already reaches it; then the facts read the settings again. */
export const pauseUpdates = async (io: PauseIo, until: number): Promise<PauseOutcome> => {
    const current = await io.current();
    const writes = pauseWrites(io.now(), until, current);
    if (writes.length === 0 && current !== undefined) {
        return { kind: "already", until: current };
    }
    await io.write(pauseScript(writes));
    // allow(silent-catch): a missing stamp only leaves the resident's reading stale for up to half an hour (POWER_REFRESH_MS)
    await io.changed().catch(() => undefined);
    return { kind: "paused", until };
};
