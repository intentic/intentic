import { usePoll } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { effectScope, watch } from "vue";

// FROM THE PRESS UNTIL THE SANDBOX ANSWERS ON WHAT IT WAS SWAPPED ONTO. Every swap HostRecreate runs is relayed by the
// daemon it replaces, so its stream should die at the cutover; but a relayed stream can stay half-open (one did for
// twelve minutes in WebKitGTK, with "Rebuilding" on screen all along), so its end is not what this waits for. A follow
// is armed at the press and ends at whichever comes first: the sandbox answering on what the swap aimed at, or a
// deadline below, which ends it with the words for not knowing. It belongs to no view: a press's follow runs inside the
// operation that ran the swap, so walking away mid-swap leaves it watching, and a rebuild the sandbox started by itself
// is followed for as long as its card is open.

// A stream that died while the sandbox never went quiet was not the cutover: lost contact, once this runs out.
const CUTOVER_GRACE_MS = 60_000;
// How long the sandbox may stay out of reach once it went quiet; a swap's restart takes about half a minute.
const DOWN_PATIENCE_MS = 3 * 60_000;
// How long it may answer again with the swap not landed and the stream silent. A stream still printing is a swap still
// running (the page's own connection blinked mid-download); a silent one past this will never end.
const BACK_PATIENCE_MS = 3 * 60_000;
// How often an answering sandbox is asked what it runs while the swap has not landed.
const LANDED_POLL_MS = 5_000;

/** Where a followed swap is, for the lines under its button. */
export interface SwapProgress {
    /** The device's stream is still open: the download and build before the cutover. */
    readonly streaming: boolean;
    /** The stream ended with no answer, which may be the cutover. */
    readonly severed: boolean;
    /** The sandbox went out of reach since the press. */
    readonly wentDown: boolean;
}

/** How a swap run from here ended well: the device answered in words, or the sandbox answers on what it was swapped onto. */
export type SwapEnd = { readonly said: string } | { readonly landed: true };

/** A follow that stopped waiting, carrying the words for not knowing at that point. */
export class SwapGaveUp extends Error {}

type GiveUp = `capabilities.hostRecreate.lostBeforeRestart` | `capabilities.hostRecreate.returnTimedOut`;

export interface SwapFollowOptions {
    /** Whether the sandbox serving this page answers. */
    readonly reachable: () => boolean;
    /** Whether the sandbox on screen is still the one being swapped: another one's answers say nothing about this swap. */
    readonly here: () => boolean;
    /** Whether what answers now is what the swap aimed at, given where the follow is. */
    readonly landed: (now: SwapProgress) => Promise<boolean>;
    /** A press reads the device's stream from the start; a rebuild the sandbox started has none. */
    readonly streaming: boolean;
    readonly progress: (now: SwapProgress) => void;
}

export interface SwapFollow {
    /** Settles once the swap is seen landing; rejects with SwapGaveUp once a deadline runs out; never settles after `stop`. */
    readonly landed: Promise<void>;
    /** A line from the device: the swap still running, so the patience for a sandbox back but not landed restarts. */
    readonly heard: () => void;
    /** The stream ended with no answer, which may be the cutover: waited out from here. */
    readonly streamDied: () => void;
    /** Lets go, however it stands. */
    readonly stop: () => void;
}

// Every follow still watching, so a test can end the ones its case left behind.
const live = new Set<() => void>();

export const followSwap = (options: SwapFollowOptions): SwapFollow => {
    const scope = effectScope(true);
    let now: SwapProgress = { streaming: options.streaming, severed: false, wentDown: false };
    let watching = true;
    let asking = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let settle: () => void = () => undefined;
    let giveUp: (error: SwapGaveUp) => void = () => undefined;
    const landed = new Promise<void>((resolve, reject) => {
        settle = resolve;
        giveUp = reject;
    });
    // allow(silent-catch): a deadline can run out before anybody awaits this (while the stream still races it); whoever awaits it hears the refusal, and that is no unhandled one.
    landed.catch(() => undefined);

    const set = (patch: Partial<SwapProgress>): void => {
        now = { ...now, ...patch };
        options.progress(now);
    };
    const stop = (): void => {
        watching = false;
        clearTimeout(deadline);
        scope.stop();
        live.delete(stop);
    };
    // One deadline at a time, each saying what not knowing means at that point.
    const giveUpIn = (ms: number, said: GiveUp): void => {
        clearTimeout(deadline);
        deadline = setTimeout(() => {
            if (watching) {
                stop();
                giveUp(new SwapGaveUp(t(said)));
            }
        }, ms);
    };
    const check = async (): Promise<void> => {
        if (!watching || !options.here() || !options.reachable() || asking) {
            return;
        }
        asking = true;
        // allow(silent-catch): a sandbox still coming up refuses its reads; that is "not landed yet", and the next poll asks again
        const yes = await options.landed(now).catch(() => false);
        asking = false;
        if (yes && watching) {
            stop();
            settle();
        }
    };

    live.add(stop);
    options.progress(now);
    scope.run(() => {
        usePoll({ everyMs: LANDED_POLL_MS, check, immediate: false }).start();
        // Undefined while another sandbox is on screen: its connection says nothing about this one, so the clock waits.
        watch(
            () => (options.here() ? options.reachable() : undefined),
            (up) => {
                if (!watching) {
                    return;
                }
                if (up === undefined) {
                    clearTimeout(deadline);
                    return;
                }
                if (!up) {
                    set({ wentDown: true });
                    giveUpIn(DOWN_PATIENCE_MS, `capabilities.hostRecreate.returnTimedOut`);
                    return;
                }
                // Back: landed, or only this page's connection blinked while the swap runs on, which its next line says (heard).
                giveUpIn(BACK_PATIENCE_MS, `capabilities.hostRecreate.returnTimedOut`);
                void check();
            },
        );
    });
    if (options.here() && !options.reachable()) {
        set({ wentDown: true });
        giveUpIn(DOWN_PATIENCE_MS, `capabilities.hostRecreate.returnTimedOut`);
    }

    return {
        landed,
        heard: () => {
            if (watching && now.wentDown && options.here() && options.reachable()) {
                giveUpIn(BACK_PATIENCE_MS, `capabilities.hostRecreate.returnTimedOut`);
            }
        },
        streamDied: () => {
            if (!watching) {
                return;
            }
            set({ streaming: false, severed: true });
            if (!now.wentDown) {
                giveUpIn(CUTOVER_GRACE_MS, `capabilities.hostRecreate.lostBeforeRestart`);
            }
        },
        stop,
    };
};

/** Test seam: a follow outlives its view on purpose, and one left watching would follow one test into the next. */
export const forgetSwapFollows = (): void => {
    for (const stop of [...live]) {
        stop();
    }
};
