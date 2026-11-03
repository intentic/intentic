import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
    DevicePingSchema,
    HOST_CRASH_LOOKBACK_MS,
    HOST_NATIVE_ENVIRONMENT,
    type HostCrashEvent,
    hostConnectionKey,
    parseHostConnection,
} from "@intentic/sandbox-contract/schemas/hosts";
import type { SandboxSettings } from "@intentic/sandbox-contract/schemas/settings";
import { HOST_CRASHES_FILE } from "../../system/boot/restarts/restart-record.js";
import { type HostCrashRow, readHostCrashes } from "../../system/boot/restarts/host-crash-rows.js";
import type { Pinged } from "../../peers/peer-hub.js";

/* THE HOST'S CRASHES AND GPU RESETS, KEPT AND ACTED ON (2026-11-03). On 2026-11-02 rog's display GPU hung under a page an
   agent rendered through WSL (LiveKernelEvent 0x141) and the PC powered off; the sandbox could only say its run "was
   killed without warning", and nothing stopped the next GPU job. The Windows side's agent now answers each heartbeat with
   what Windows logged of the last day (DevicePingSchema `crashes`, environments/windows-crash-events.ts in
   @intentic/machine). This keeps each event once, in HOST_CRASHES_FILE beside the restart record, where the diagnostics
   `restarts` tool names it as the cause of a run killed without warning; and the first time it hears of a GPU reset on
   the computer running this sandbox, it pauses GPU work (settings `gpu.pausedFor`, which gpu-run refuses on) until the
   owner resumes it.

   Only the computer running this sandbox counts: a crash on another connected machine says nothing about this sandbox's
   GPU. While which computer that is is not known yet (nothing has listed the devices since boot), nothing is kept: the
   agent repeats the day's events on every beat, so they are kept on the first beat after it is known. */

// The rows kept, newest last: months of a crash-prone PC, and small enough to rewrite whole.
export const HOST_CRASHES_KEPT = 200;

/** The events a door's last heartbeat carried; none for an agent older than the field or an answer that does not parse. */
export const crashesOf = (pinged: Pinged | undefined): HostCrashEvent[] => {
    const parsed = DevicePingSchema.safeParse(pinged?.answer);
    return parsed.success ? (parsed.data.crashes ?? []) : [];
};

/** The doors that speak for the computer running this sandbox: its own, and that machine's Windows side. Pure. */
export const selfDoors = (self: string): string[] => [...new Set([self, hostConnectionKey(parseHostConnection(self).card, HOST_NATIVE_ENVIRONMENT)])];

/** What is new among `events`, against what is kept: by id, once per machine card. Pure. */
export const unheard = (kept: readonly HostCrashRow[], card: string, events: readonly HostCrashEvent[]): HostCrashEvent[] => {
    const known = new Set(kept.filter((row) => row.host === card).map((row) => row.id));
    const seen = new Set<string>();
    return events.filter((event) => {
        if (known.has(event.id) || seen.has(event.id)) {
            return false;
        }
        seen.add(event.id);
        return true;
    });
};

/** The sentence GPU work is paused for, naming the event. */
export const pauseReason = (card: string, event: HostCrashEvent): string =>
    `${card} reported a GPU reset at ${event.at} (${event.code}${event.detail === undefined ? "" : `: ${event.detail.slice(0, 160)}`}). A GPU hang can freeze or power off that computer, so gpu-run is paused until you look.`;

/**
 * The GPU reset newly heard that should pause GPU work: the newest one Windows logged within the day before `now`, when
 * nothing is paused already (the owner's resume is never undone by an event they have already seen). Pure.
 */
export const resetToPause = (fresh: readonly HostCrashEvent[], gpu: SandboxSettings["gpu"], now: number): HostCrashEvent | undefined => {
    if (gpu.pausedFor !== undefined) {
        return undefined;
    }
    return fresh
        .filter((event) => event.kind === "gpu-reset" && now - Date.parse(event.at) <= HOST_CRASH_LOOKBACK_MS)
        .toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
};

// Appends, and rewrites the file whole once it holds more than it keeps.
const keepRows = async (logsDir: string, kept: readonly HostCrashRow[], added: readonly HostCrashRow[]): Promise<void> => {
    const path = join(logsDir, HOST_CRASHES_FILE);
    const lines = (rows: readonly HostCrashRow[]): string => rows.map((row) => `${JSON.stringify(row)}\n`).join("");
    if (kept.length + added.length > HOST_CRASHES_KEPT) {
        await writeFile(path, lines([...kept, ...added].slice(-HOST_CRASHES_KEPT)));
        return;
    }
    await appendFile(path, lines(added));
};

// What a kept event's log line carries.
export interface CrashLogFields {
    readonly host: string;
    readonly code: string;
    readonly at: string;
    readonly kind?: HostCrashEvent["kind"];
}

export interface CrashWatchDeps {
    readonly logsDir: string;
    // The hub key of the door running this sandbox; undefined while unknown.
    readonly self: () => Promise<string | undefined>;
    // Asks for a device listing, by which `self` becomes known; called at most once per FIND_SELF_MS.
    readonly findSelf: () => void;
    readonly pinged: (door: string) => Pinged | undefined;
    readonly connected: () => readonly string[];
    readonly settings: { readonly get: () => Promise<SandboxSettings>; readonly set: (settings: SandboxSettings) => Promise<void> };
    readonly log: { readonly warn: (fields: CrashLogFields, message: string) => void };
    readonly now?: () => number;
}

const FIND_SELF_MS = 5 * 60_000;

/** One pass: keep what the running computer reported that is new, and pause GPU work on a fresh GPU reset. */
export const createCrashWatch = (deps: CrashWatchDeps): (() => Promise<void>) => {
    const now = deps.now ?? Date.now;
    let askedAt = Number.NEGATIVE_INFINITY;
    let running = false;
    return async () => {
        if (running) {
            return;
        }
        running = true;
        try {
            const self = await deps.self();
            if (self === undefined) {
                // Something is connected and might be the machine running this sandbox; a listing says which.
                if (deps.connected().some((door) => crashesOf(deps.pinged(door)).length > 0) && now() - askedAt >= FIND_SELF_MS) {
                    askedAt = now();
                    deps.findSelf();
                }
                return;
            }
            const card = parseHostConnection(self).card;
            const kept = await readHostCrashes(deps.logsDir);
            const fresh = unheard(kept, card, selfDoors(self).flatMap((door) => crashesOf(deps.pinged(door))));
            if (fresh.length === 0) {
                return;
            }
            const heardAt = new Date(now()).toISOString();
            await keepRows(deps.logsDir, kept, fresh.map((event) => ({ ...event, host: card, heardAt })));
            for (const event of fresh) {
                deps.log.warn({ host: card, code: event.code, at: event.at, kind: event.kind }, `host: ${card} reported ${event.kind === "gpu-reset" ? "a GPU reset" : "a crash"} (${event.code}) at ${event.at}`);
            }
            const settings = await deps.settings.get();
            const reset = resetToPause(fresh, settings.gpu, now());
            if (reset !== undefined) {
                await deps.settings.set({ ...settings, gpu: { ...settings.gpu, pausedFor: pauseReason(card, reset) } });
                deps.log.warn({ host: card, code: reset.code, at: reset.at }, "gpu: GPU work paused after the host's GPU reset; gpu-run refuses until the owner resumes it");
            }
        } finally {
            running = false;
        }
    };
};
