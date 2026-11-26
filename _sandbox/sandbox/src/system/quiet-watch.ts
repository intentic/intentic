import type { Logger } from "pino";
import { opt } from "../opt.js";

// Tell the host keeper when sleep is safe: quietSince requires no editor, clock-driven work, terminal activity or workspace-app users.
// Terminal input advances the quiet start. nextWakeAt is the earliest promised job; personAt is last presence this boot (0 if none).
// keepAwake (owner setting or continuous event/listener reception) suppresses quietSince entirely.
// Refresh the work signal each minute and via sleep-socket.ts just before stopping, so newly booked work cannot be missed.

/* CONNECTED IS NOT USED (2026-11-26). An editor left open in a background tab or on screen overnight keeps its
   connection, so quietSince never comes while the browser runs: on rog a sandbox nobody had opened for 15 hours held
   1.9 GB while Windows was short. Beside it, then, two more facts for the machine's sleep for memory, and only for it
   (the keeper's own sleep and a hosted idle-stop keep connected as somebody there):
   - activeAt: the last moment a person did something here this boot, an editor with somebody at it (presence.ts
     editorActiveAt, off the editor's own `idle` and `away`), a terminal typed in, or an app of it in use; 0 for none;
   - unattendedSince: quietSince's streak with an editor nobody has been at for EDITOR_IDLE_MS counted as nobody, so
     what it starts from is the last activity, not the moment the tab closes. A person back at the editor ends it at the
     next look, and the sleep socket's look is taken after the host asks, so its answer refuses. */
export const EDITOR_IDLE_MS = 30 * 60_000;

export interface QuietProbes {
    readonly connected: () => number;
    readonly working: () => number;
    // Freshest terminal activity a person made, in ms; 0 for none.
    readonly terminalActivityAt: () => Promise<number>;
    readonly appsInUse: () => Promise<boolean>;
    // The last moment a person was at a connected editor: `now` while one is, 0 for none this boot (presence.ts).
    readonly editorActiveAt: (now: number) => number;
    // The soonest promised wake, in ms; 0 for none.
    readonly nextWakeAt: () => Promise<number>;
    // Whether settings or an enabled continuous receiver requires the sandbox to stay awake.
    readonly keepAwake: () => Promise<boolean>;
}

export interface QuietReading {
    readonly quietSince?: number;
    readonly unattendedSince?: number;
    readonly nextWakeAt?: number;
    readonly personAt?: number;
    readonly activeAt?: number;
    readonly keepAwake?: true;
}

export interface QuietWatch {
    // The latest reading, synchronously, for a writer that keeps its own beat.
    readonly read: () => QuietReading;
    // One pass, as the timer runs it, and what the sleep socket awaits: a call made while a pass is in flight is answered
    // by another pass after it, so the reading it resolves to began after the call.
    readonly check: () => Promise<void>;
    readonly stop: () => void;
}

const CHECK_INTERVAL_MS = 60_000;

const same = (a: QuietReading, b: QuietReading): boolean =>
    a.quietSince === b.quietSince &&
    a.unattendedSince === b.unattendedSince &&
    a.nextWakeAt === b.nextWakeAt &&
    a.personAt === b.personAt &&
    a.activeAt === b.activeAt &&
    a.keepAwake === b.keepAwake;

// A reading that certifies no sleep: neither streak.
const unconfirmed = ({ quietSince: _was, unattendedSince: _unattended, ...held }: QuietReading): QuietReading => held;

// The same, keeping the unattended streak: somebody is connected, but nobody has been at an editor for long.
const connectedOnly = ({ quietSince: _was, ...held }: QuietReading): QuietReading => held;

// What one pass saw.
export interface QuietPass {
    readonly at: number;
    // Settings or a receiver keep it awake.
    readonly kept: boolean;
    // Work, an app in use, or somebody at an editor right now: no streak stands.
    readonly needed: boolean;
    // An editor is connected: the strict streak cannot stand.
    readonly connected: boolean;
    // An editor is connected that somebody was at within EDITOR_IDLE_MS: the unattended one cannot either.
    readonly attended: boolean;
    // The freshest terminal input, 0 for none.
    readonly typedAt: number;
}

// When each streak began, undefined while something needs the sandbox.
export interface QuietStreaks {
    readonly quiet: number | undefined;
    readonly unattended: number | undefined;
}

export const NO_STREAKS: QuietStreaks = { quiet: undefined, unattended: undefined };

// One pass's outcome: the streaks it leaves, and the part of the reading they certify.
export interface QuietVerdict {
    readonly streaks: QuietStreaks;
    readonly certified: Pick<QuietReading, "quietSince" | "unattendedSince">;
}

// The streaks after one pass, and what they certify: quietSince from the strict one, moved forward by typing;
// unattendedSince from the other, moved forward by any activity (`activeAt`). The unattended streak is not broken by a
// connection, so an editor left alone counts from when somebody was last at it, not from when it closes. Pure.
export const streaksAfter = (pass: QuietPass, was: QuietStreaks, activeAt: number): QuietVerdict => {
    if (pass.kept || pass.needed) {
        return { streaks: NO_STREAKS, certified: {} };
    }
    const unattended = was.unattended ?? pass.at;
    const quiet = pass.connected ? undefined : (was.quiet ?? pass.at);
    return {
        streaks: { quiet, unattended },
        certified: {
            ...opt("quietSince", quiet === undefined ? undefined : Math.max(quiet, pass.typedAt)),
            ...opt("unattendedSince", pass.attended ? undefined : Math.max(unattended, activeAt)),
        },
    };
};

export const startQuietWatch = (
    probes: QuietProbes,
    options: { readonly logger: Pick<Logger, "warn">; readonly onChange?: () => void; readonly checkMs?: number; readonly now?: () => number },
): QuietWatch => {
    const now = options.now ?? Date.now;
    let streaks = NO_STREAKS;
    // The last moment a person was seen here since this boot, and the last one did something; 0 for none.
    let personAt = 0;
    let activeAt = 0;
    let reading: QuietReading = {};
    let requested = false;
    let flight: Promise<void> | undefined;
    let stopped = false;
    const busy = (): boolean => probes.connected() > 0 || probes.working() > 0;
    // An editor connected with somebody at it within EDITOR_IDLE_MS: a person, for the unattended streak too.
    const attended = (at: number): boolean => probes.connected() > 0 && at - probes.editorActiveAt(at) < EDITOR_IDLE_MS;

    const settle = (next: QuietReading): void => {
        if (same(reading, next)) {
            return;
        }
        reading = next;
        options.onChange?.();
    };

    const sample = async (): Promise<void> => {
        const wakeAt = await probes.nextWakeAt();
        if (probes.connected() > 0) {
            personAt = now();
        }
        const kept = await probes.keepAwake();
        if (stopped) {
            return;
        }
        // Work, or somebody at an editor right now: nothing read below could certify a streak, so tmux is not asked.
        const atWork = probes.working() > 0 || (probes.connected() > 0 && probes.editorActiveAt(now()) === now());
        const [typedAt, inUse] = kept || atWork ? [0, false] : await Promise.all([probes.terminalActivityAt(), probes.appsInUse()]);
        if (stopped) {
            return;
        }
        // Read again after the awaits: somebody may have connected, or come back, while tmux and the socket tables were read.
        const at = now();
        personAt = Math.max(personAt, typedAt, inUse ? at : 0);
        activeAt = Math.max(activeAt, probes.editorActiveAt(at), typedAt, inUse ? at : 0);
        const pass = { at, kept, needed: atWork || inUse || probes.working() > 0, connected: probes.connected() > 0, attended: attended(at), typedAt };
        const next = streaksAfter(pass, streaks, activeAt);
        streaks = next.streaks;
        settle({ ...next.certified, ...opt("nextWakeAt", wakeAt > 0 ? wakeAt : undefined), personAt, activeAt, ...opt("keepAwake", kept ? (true as const) : undefined) });
    };

    // One pass at a time; a call during one queues another, so no caller is answered by a pass that began before it.
    const check = (): Promise<void> => {
        requested = true;
        flight ??= (async () => {
            try {
                while (requested) {
                    if (stopped) { return; }
                    requested = false;
                    await sample();
                }
            } catch (error) {
                streaks = NO_STREAKS;
                // Keep the last known alarm, but never certify sleep on incomplete readings.
                settle(unconfirmed(reading));
                throw error;
            }
        })().finally(() => { flight = undefined; });
        return flight;
    };
    const pass = (): void => void check().catch((error: unknown) => options.logger.warn({ err: error }, "quiet watch: a check failed"));
    const timer = setInterval(pass, options.checkMs ?? CHECK_INTERVAL_MS);
    // A watchdog must never hold the event loop open on its own.
    timer.unref();
    pass();
    return {
        // What is seen synchronously since the last pass withdraws what it would contradict: work or a person back at an
        // editor withdraws both streaks, a connection only the strict one.
        read: () => {
            if (probes.working() > 0 || attended(now())) {
                return unconfirmed(reading);
            }
            return busy() ? connectedOnly(reading) : reading;
        },
        check,
        stop: () => {
            stopped = true;
            clearInterval(timer);
        },
    };
};
