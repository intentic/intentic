import { computed, type ComputedRef, effectScope, ref, watch } from "vue";
import { desktopRecreateLink, desktopTakesProcesses, openDesktopLink } from "../../../../app/environments/desktop";
import { processLive, type ProcessReport, type RecreateMode, recreateMode } from "../../../../app/environments/processes/processReport";
import { useFaceProcesses } from "../../../../models/processes/faceProcesses";
import { expectRestart, type RestartWork } from "../../../../models/sandbox/live/sandboxRestart";

// A SWAP HANDED TO THE DESKTOP APP. In the app, Update now / Rebuild / Roll back is a link the app runs on this machine
// (desktopRecreateLink), and the card used to forget it the moment it was pressed: the button went on offering
// "Update now" while the only sign of the run was a tile on the rail. The app reports the run as `recreate:<slug>`
// (processReport.ts), so the card follows that report instead: from the press until the app is heard taking it, then for
// as long as the app's run works, and it says how it ended when it failed.
//
// The press outlives the card that made it, as every swap here does: the follow and its restart expectation are the
// press's own, ended by the app's run ending (or by the app never answering), never by the card being closed.

/** How long a press waits to hear the app take it before saying it did not (it was busy with another run, or closed). */
const APP_TAKES_MS = 15_000;

/** The app's run for a sandbox's swaps, one id for all three (desktop-app's device/sandboxes.ts). */
const appRecreateId = (slug: string): string => `recreate:${slug}`;

// allow(module-state): the presses handed to the app and not yet heard taken, by slug, so a card opened again still says so
const handing = ref<ReadonlySet<string>>(new Set());
// allow(module-state): the slugs whose last press the app never answered
const unanswered = ref<ReadonlySet<string>>(new Set());

const marked = (set: ReadonlySet<string>, slug: string, on: boolean): ReadonlySet<string> => {
    const next = new Set(set);
    if (on) {
        next.add(slug);
    } else {
        next.delete(slug);
    }
    return next;
};

export interface AppRecreatePress {
    readonly slug: string;
    readonly hash?: string | undefined;
    readonly rollback: boolean;
    /** The restart this ends in, said by every surface while the app's run holds it. */
    readonly restart?: Omit<RestartWork, `startedAt` | `fromPress` | `untilAnswered`> | undefined;
}

/** Hands a swap to the app and follows it until the app's run ends. */
export const pressAppRecreate = (press: AppRecreatePress): void => {
    const { slug } = press;
    openDesktopLink(desktopRecreateLink(slug, press.hash, press.rollback));
    // An app from before the process list tells nothing back: there is nothing to follow.
    if (!desktopTakesProcesses() || handing.value.has(slug)) {
        return;
    }
    handing.value = marked(handing.value, slug, true);
    unanswered.value = marked(unanswered.value, slug, false);
    const release = press.restart === undefined ? undefined : expectRestart({ ...press.restart, fromPress: true });
    const scope = effectScope(true);
    let taken = false;
    // Over, one way or another: the app's run ended, or the app never took the press.
    const ending = { end: (): void => undefined };
    const timer = setTimeout(() => {
        if (!taken) {
            unanswered.value = marked(unanswered.value, slug, true);
            ending.end();
        }
    }, APP_TAKES_MS);
    ending.end = (): void => {
        clearTimeout(timer);
        handing.value = marked(handing.value, slug, false);
        release?.();
        scope.stop();
    };
    scope.run(() => {
        const { list } = useFaceProcesses();
        watch(
            () => list.value.find((report) => report.id === appRecreateId(slug)),
            (run) => {
                if (run !== undefined && processLive(run)) {
                    taken = true;
                    handing.value = marked(handing.value, slug, false);
                    return;
                }
                // A report from an earlier run (done, failed) is not this press's end; only the one it started is.
                if (taken) {
                    ending.end();
                }
            },
            { immediate: true },
        );
    });
};

export interface AppRecreate {
    /** The app's run for this sandbox, as it last reported it. */
    readonly run: ComputedRef<ProcessReport | undefined>;
    /** Pressed and not yet taken, or taken and working: the button holds and says so. */
    readonly busy: ComputedRef<boolean>;
    /** Pressed, and the app not yet heard taking it. */
    readonly handing: ComputedRef<boolean>;
    /** The app's run works now. */
    readonly live: ComputedRef<boolean>;
    /** Which swap the running one is, by the app's word; undefined from an app that does not say. */
    readonly mode: ComputedRef<RecreateMode | undefined>;
    /** The app's run failed: its reason, `` where it gave none. */
    readonly failure: ComputedRef<string | undefined>;
    /** The last press was never taken by the app. */
    readonly silent: ComputedRef<boolean>;
}

/** Where this sandbox's swap in the app stands, for a card to draw. */
export const useAppRecreate = (slug: () => string): AppRecreate => {
    const { list } = useFaceProcesses();
    const run = computed(() => list.value.find((report) => report.id === appRecreateId(slug())));
    const live = computed(() => run.value !== undefined && processLive(run.value));
    const handingNow = computed(() => handing.value.has(slug()));
    const busy = computed(() => handingNow.value || live.value);
    return {
        run,
        busy,
        handing: handingNow,
        live,
        mode: computed(() => (run.value === undefined || !live.value ? undefined : recreateMode(run.value))),
        failure: computed(() => (busy.value || run.value?.state !== `failed` ? undefined : (run.value.failure ?? ``))),
        silent: computed(() => !busy.value && unanswered.value.has(slug())),
    };
};
