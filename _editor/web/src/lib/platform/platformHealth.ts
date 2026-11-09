import { computed, readonly, ref, type ComputedRef, type Ref } from "vue";
import { environment } from "../../app/environments/environment";

// WHETHER THE PLATFORM IS ANSWERING, as one reading every part of the editor shares (2026-11-09). Before this each caller
// found out on its own: the session check sent the reader to a full-screen outage page, a rename failed with an error,
// the switcher went quiet. Now every answer the platform gives (useApi.ts, the Better Auth client in useAuth.ts) and every
// call it could not answer is reported here, and the reading drives the small offline indicator in the status bar, the
// actions that wait for the platform, and the quiet return to normal when it answers again.
//
// THE RULE IS THE SAME ONE THE SERVICE WORKER AND THE EDGE COPY USE (public/sw.js `fallsBack`): no answer at all, 500,
// or 502–599 (Cloudflare's 52x and 530 for a box that is down) is down. Anything else is the platform answering, a
// refusal included: a 401 is the platform saying who you are not, which is the platform up.
//
// While it reads down, a cheap question (`GET /api/identity`, no session) is asked every PROBE_EVERY_MS and whenever the
// browser comes back online, so the reading turns up again by itself even in a window that asks the platform nothing.

export type PlatformHealthState = `unknown` | `up` | `down`;

// Often enough that the indicator goes away within moments of the platform coming back, rarely enough that a window
// left open through a long outage asks a few hundred times an hour at most.
export const PROBE_EVERY_MS = 15_000;
// A probe the platform never answers is cut here and counted as down.
const PROBE_TIMEOUT_MS = 8_000;

/** The statuses a dead platform is served as: 500, and 502 through 599. 501 and everything below are answers. */
export const isOutageStatus = (status: number): boolean => status === 500 || (status >= 502 && status <= 599);

export interface PlatformHealthDeps {
    readonly probe: () => Promise<number>;
    readonly now: () => number;
    /** Runs `run` once after `ms`; the answer cancels it. */
    readonly schedule: (run: () => void, ms: number) => () => void;
}

export interface PlatformHealth {
    readonly state: Readonly<Ref<PlatformHealthState>>;
    readonly down: ComputedRef<boolean>;
    /** When the current outage began (ms); undefined while up. */
    readonly downSince: Readonly<Ref<number | undefined>>;
    /** An answer the platform gave: its HTTP status. */
    readonly noteStatus: (status: number) => void;
    /** A call the platform could not answer at all: a network error, a timeout. */
    readonly noteUnreachable: () => void;
    /** Asks the platform now, the way the loop does; resolves with the reading after it. */
    readonly checkNow: () => Promise<PlatformHealthState>;
    /** Called once each time the reading turns from down to up. */
    readonly onRecovered: (listener: () => void) => () => void;
}

export const createPlatformHealth = (deps: PlatformHealthDeps): PlatformHealth => {
    const state = ref<PlatformHealthState>(`unknown`);
    const downSince = ref<number | undefined>(undefined);
    const recovered = new Set<() => void>();
    let cancelProbe: (() => void) | undefined;

    const stopProbing = (): void => {
        cancelProbe?.();
        cancelProbe = undefined;
    };

    const markUp = (): void => {
        const wasDown = state.value === `down`;
        state.value = `up`;
        downSince.value = undefined;
        stopProbing();
        if (wasDown) {
            for (const listener of recovered) {
                listener();
            }
        }
    };

    const markDown = (): void => {
        if (state.value !== `down`) {
            state.value = `down`;
            downSince.value = deps.now();
        }
        scheduleProbe();
    };

    const noteStatus = (status: number): void => {
        if (isOutageStatus(status)) {
            markDown();
            return;
        }
        markUp();
    };

    const checkNow = async (): Promise<PlatformHealthState> => {
        try {
            noteStatus(await deps.probe());
        } catch {
            // allow(silent-catch): an unanswered probe is the reading it produces, down.
            markDown();
        }
        return state.value;
    };

    // One probe pending at a time, only while down: an up platform is heard about from the calls the editor makes anyway.
    function scheduleProbe(): void {
        if (cancelProbe !== undefined) {
            return;
        }
        cancelProbe = deps.schedule(() => {
            cancelProbe = undefined;
            void checkNow();
        }, PROBE_EVERY_MS);
    }

    return {
        state: readonly(state),
        down: computed(() => state.value === `down`),
        downSince: readonly(downSince),
        noteStatus,
        noteUnreachable: markDown,
        checkNow,
        onRecovered: (listener) => {
            recovered.add(listener);
            return () => recovered.delete(listener);
        },
    };
};

const probeIdentity = async (): Promise<number> =>
    (await fetch(`${environment.api.url}/api/identity`, { cache: `no-store`, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })).status;

// allow(module-state): one platform per page, and one reading of it every caller shares
export const platformHealth = createPlatformHealth({
    probe: probeIdentity,
    now: () => Date.now(),
    schedule: (run, ms) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
    },
});

// Back online is the moment a down platform is most likely answering again: ask at once rather than at the next tick.
globalThis.addEventListener?.(`online`, () => {
    if (platformHealth.down.value) {
        void platformHealth.checkNow();
    }
});

/**
 * Wraps one platform call so its outcome is reported: the answer's status, or that nothing answered. An abort the caller
 * asked for is not the platform's doing and is passed on unreported.
 */
export const reportedFetch = async (send: () => Promise<Response>, health: PlatformHealth = platformHealth): Promise<Response> => {
    let response: Response;
    try {
        response = await send();
    } catch (error) {
        if (!(error instanceof DOMException && error.name === `AbortError`)) {
            health.noteUnreachable();
        }
        throw error;
    }
    health.noteStatus(response.status);
    return response;
};
