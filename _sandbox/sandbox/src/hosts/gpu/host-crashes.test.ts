import { HOST_CRASH_LOOKBACK_MS, type HostCrashEvent } from "@intentic/sandbox-contract/schemas/hosts";
import { GpuSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { type HostCrashRow, parseCrashRows } from "../../system/boot/restarts/host-crash-rows.js";
import { crashesOf, pauseReason, resetToPause, selfDoors, unheard } from "./host-crashes.js";

const NOW = Date.UTC(2026, 10, 2, 19, 40, 0);
const event = (over: Partial<HostCrashEvent> = {}): HostCrashEvent => ({
    id: "Application:9001",
    at: new Date(NOW - 10 * 60_000).toISOString(),
    kind: "gpu-reset",
    code: "LiveKernelEvent 141",
    ...over,
});
const row = (over: Partial<HostCrashRow> = {}): HostCrashRow => ({ ...event(), host: "rog", heardAt: new Date(NOW).toISOString(), ...over });
const gpu = GpuSettingsSchema.parse({});

test("a door's heartbeat answers with its crashes; an older agent or an answer that does not parse has none", () => {
    expect(crashesOf({ at: NOW, answer: { ok: true, crashes: [event()] } })).toEqual([event()]);
    expect(crashesOf({ at: NOW, answer: { ok: true } })).toEqual([]);
    expect(crashesOf({ at: NOW, answer: { ok: true, crashes: [{ id: 1 }] } })).toEqual([]);
    expect(crashesOf(undefined)).toEqual([]);
});

// The Windows side speaks for a sandbox running in that PC's WSL distro.
test("the computer running the sandbox is heard through its own door and its Windows side", () => {
    expect(selfDoors("rog::wsl:archlinux")).toEqual(["rog::wsl:archlinux", "rog"]);
    expect(selfDoors("rog")).toEqual(["rog"]);
});

test("an event is new once per machine, whichever door or beat repeats it", () => {
    const kept = [row({ id: "System:1" }), row({ id: "System:2", host: "omen" })];
    const fresh = unheard(kept, "rog", [event({ id: "System:1" }), event({ id: "System:2" }), event({ id: "System:2" })]);
    expect(fresh.map((one) => one.id)).toEqual(["System:2"]);
});

test("a fresh GPU reset pauses GPU work; a host crash alone, a stale reset or a pause already standing does not", () => {
    const newer = event({ id: "System:7", code: "Display 4101", at: new Date(NOW - 60_000).toISOString() });
    expect(resetToPause([event(), newer, event({ id: "System:8", kind: "host-crash", code: "Kernel-Power 41" })], gpu, NOW)).toEqual(newer);
    expect(resetToPause([event({ kind: "host-crash", code: "Kernel-Power 41" })], gpu, NOW)).toBeUndefined();
    expect(resetToPause([event({ at: new Date(NOW - HOST_CRASH_LOOKBACK_MS - 1).toISOString() })], gpu, NOW)).toBeUndefined();
    expect(resetToPause([event()], { ...gpu, pausedFor: "earlier" }, NOW)).toBeUndefined();
});

test("the pause names the machine, the time and Windows' code", () => {
    expect(pauseReason("rog", event({ detail: "Event Name: LiveKernelEvent" }))).toBe(
        `rog reported a GPU reset at ${event().at} (LiveKernelEvent 141: Event Name: LiveKernelEvent). A GPU hang can freeze or power off that computer, so gpu-run is paused until you look.`,
    );
});

test("rows another build wrote are read line by line, skipping what does not parse", () => {
    expect(parseCrashRows(`${JSON.stringify(row())}\nnot json\n{"id":"x"}\n\n`)).toEqual([row()]);
});
