import { UPDATE_PAUSE_MAX_MS } from "@intentic/sandbox-contract/schemas/host-power";
import { type PauseIo, pauseScript, pauseUpdates, pauseWrites, windowsUpdateTime } from "./update-pause.js";

/* WINDOWS UPDATE PAUSED PAST THE BOOKED WORK (2026-11-27): the six values Windows' own Settings page writes, never a pause
   shortened, never one longer than Windows allows. */

const NOW = Date.UTC(2026, 10, 26, 23, 35, 12, 500);
const FRIDAY_EIGHT = Date.UTC(2026, 10, 28, 7, 0);

describe("pauseWrites", () => {
    it("writes every start and end Settings writes, in UTC to the second", () => {
        expect(pauseWrites(NOW, FRIDAY_EIGHT, undefined)).toEqual([
            { name: "PauseUpdatesStartTime", value: "2026-11-26T23:35:12Z" },
            { name: "PauseFeatureUpdatesStartTime", value: "2026-11-26T23:35:12Z" },
            { name: "PauseQualityUpdatesStartTime", value: "2026-11-26T23:35:12Z" },
            { name: "PauseUpdatesExpiryTime", value: "2026-11-28T07:00:00Z" },
            { name: "PauseFeatureUpdatesEndTime", value: "2026-11-28T07:00:00Z" },
            { name: "PauseQualityUpdatesEndTime", value: "2026-11-28T07:00:00Z" },
        ]);
    });

    it("never shortens a pause, and lengthens one still running without moving its start", () => {
        expect(pauseWrites(NOW, FRIDAY_EIGHT, FRIDAY_EIGHT + 1)).toEqual([]);
        expect(pauseWrites(NOW, FRIDAY_EIGHT, NOW + 60_000).map((write) => write.name)).toEqual([
            "PauseUpdatesExpiryTime",
            "PauseFeatureUpdatesEndTime",
            "PauseQualityUpdatesEndTime",
        ]);
        // One that has already ended is no pause: a fresh start.
        expect(pauseWrites(NOW, FRIDAY_EIGHT, NOW - 60_000)).toHaveLength(6);
    });

    it("refuses a moment already past or further off than Windows pauses for", () => {
        expect(() => pauseWrites(NOW, NOW - 1, undefined)).toThrow("has already passed");
        expect(() => pauseWrites(NOW, NOW + UPDATE_PAUSE_MAX_MS + 1, undefined)).toThrow("five weeks at most");
    });
});

test("the script sets each value as a string, quoted so nothing in it is expanded, then has the orchestrator read them", () => {
    expect(pauseScript([{ name: "PauseUpdatesExpiryTime", value: windowsUpdateTime(FRIDAY_EIGHT) }])).toBe(
        [
            "$ErrorActionPreference = 'Stop'",
            "Set-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings' -Name 'PauseUpdatesExpiryTime' -Value '2026-11-28T07:00:00Z' -Type String",
            "try { Start-Process -FilePath (Join-Path $env:WINDIR 'System32\\UsoClient.exe') -ArgumentList 'RefreshSettings' -WindowStyle Hidden -Wait } catch { Write-Output \"Windows Update takes the pause at its next pass: $($_.Exception.Message)\" }",
        ].join("\n"),
    );
});

describe("pauseUpdates", () => {
    const io = (current: number | undefined): PauseIo & { readonly scripts: string[]; readonly stamps: number[] } => {
        const scripts: string[] = [];
        const stamps: number[] = [];
        return {
            scripts,
            stamps,
            now: () => NOW,
            current: async () => current,
            write: async (script) => void scripts.push(script),
            changed: async () => void stamps.push(1),
        };
    };

    it("writes the pause and stamps the change, so the facts read it at once", async () => {
        const fake = io(undefined);
        expect(await pauseUpdates(fake, FRIDAY_EIGHT)).toEqual({ kind: "paused", until: FRIDAY_EIGHT });
        expect(fake.scripts).toHaveLength(1);
        expect(fake.stamps).toEqual([1]);
    });

    it("writes nothing where a pause already reaches past the moment", async () => {
        const fake = io(FRIDAY_EIGHT + 3_600_000);
        expect(await pauseUpdates(fake, FRIDAY_EIGHT)).toEqual({ kind: "already", until: FRIDAY_EIGHT + 3_600_000 });
        expect([fake.scripts, fake.stamps]).toEqual([[], []]);
    });
});
