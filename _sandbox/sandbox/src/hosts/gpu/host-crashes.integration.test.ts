import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostCrashEvent } from "@intentic/sandbox-contract/schemas/hosts";
import { type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { HOST_CRASHES_FILE } from "../../system/boot/restarts/restart-record.js";
import { readHostCrashes } from "../../system/boot/restarts/host-crash-rows.js";
import { createCrashWatch, type CrashWatchDeps, HOST_CRASHES_KEPT } from "./host-crashes.js";

const NOW = Date.UTC(2026, 10, 2, 19, 40, 0);
const reset: HostCrashEvent = { id: "Application:9001", at: new Date(NOW - 10 * 60_000).toISOString(), kind: "gpu-reset", code: "LiveKernelEvent 141" };
const powerOff: HostCrashEvent = { id: "System:48213", at: new Date(NOW - 5 * 60_000).toISOString(), kind: "host-crash", code: "Kernel-Power 41" };

// A watch over a temp logs dir, the hub's last beats as the test states them, and settings held in memory.
const watchOf = (beats: Record<string, readonly HostCrashEvent[]>, self: string | undefined) => {
    const logsDir = mkdtempSync(join(tmpdir(), "host-crashes-"));
    let settings: SandboxSettings = SandboxSettingsSchema.parse({});
    const lines: string[] = [];
    const listings: number[] = [];
    const deps: CrashWatchDeps = {
        logsDir,
        self: async () => self,
        findSelf: () => listings.push(NOW),
        pinged: (door) => (beats[door] === undefined ? undefined : { at: NOW, answer: { ok: true, crashes: beats[door] } }),
        connected: () => Object.keys(beats),
        settings: {
            get: async () => settings,
            set: async (next) => {
                settings = next;
            },
        },
        log: { warn: (_fields, message) => lines.push(message) },
        now: () => NOW,
    };
    // The owner's resume: the setting cleared, as the Overview's press writes it.
    const resume = (): void => {
        const { pausedFor: _cleared, ...gpu } = settings.gpu;
        settings = { ...settings, gpu };
    };
    return { pass: createCrashWatch(deps), logsDir, settings: () => settings, resume, lines, listings };
};

test("a GPU reset on the computer running the sandbox is kept once and pauses GPU work", async () => {
    const watch = watchOf({ rog: [reset, powerOff] }, "rog::wsl:archlinux");
    await watch.pass();
    await watch.pass();

    expect((await readHostCrashes(watch.logsDir)).map((row) => [row.id, row.host])).toEqual([
        ["Application:9001", "rog"],
        ["System:48213", "rog"],
    ]);
    expect(watch.settings().gpu.pausedFor).toContain("rog reported a GPU reset at");
    expect(watch.settings().gpu.pausedFor).toContain("LiveKernelEvent 141");
    expect(watch.lines.filter((line) => line.startsWith("host: rog reported"))).toHaveLength(2);
});

// The owner looked and resumed: the same event on the next beat is no reason to pause again.
test("a resume holds against the events already heard", async () => {
    const watch = watchOf({ rog: [reset] }, "rog");
    await watch.pass();
    expect(watch.settings().gpu.pausedFor).toEqual(expect.any(String));
    watch.resume();
    await watch.pass();
    expect(watch.settings().gpu.pausedFor).toBeUndefined();
});

test("another machine's crashes are not this sandbox's, and an unknown host asks for a listing instead", async () => {
    const other = watchOf({ omen: [reset] }, "rog");
    await other.pass();
    expect(await readHostCrashes(other.logsDir)).toEqual([]);
    expect(other.settings().gpu.pausedFor).toBeUndefined();

    const unknown = watchOf({ rog: [reset] }, undefined);
    await unknown.pass();
    await unknown.pass();
    expect(unknown.listings).toHaveLength(1);
    expect(await readHostCrashes(unknown.logsDir)).toEqual([]);
});

test("the file keeps the newest rows once it would hold more than it keeps", async () => {
    const many = Array.from({ length: HOST_CRASHES_KEPT + 5 }, (_, index): HostCrashEvent => ({ ...powerOff, id: `System:${String(index)}` }));
    const watch = watchOf({ rog: many.slice(HOST_CRASHES_KEPT) }, "rog");
    const kept = many.slice(0, HOST_CRASHES_KEPT).map((one) => JSON.stringify({ ...one, host: "rog", heardAt: one.at }));
    await writeFile(join(watch.logsDir, HOST_CRASHES_FILE), `${kept.join("\n")}\n`);
    await watch.pass();
    const rows = await readHostCrashes(watch.logsDir);
    expect(rows).toHaveLength(HOST_CRASHES_KEPT);
    expect(rows.at(-1)?.id).toBe(`System:${String(HOST_CRASHES_KEPT + 4)}`);
    expect(rows[0]?.id).toBe("System:5");
});
