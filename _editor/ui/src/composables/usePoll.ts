import { computed, getCurrentScope, onScopeDispose, shallowRef, toValue, watch, type MaybeRefOrGetter, type Ref } from "vue";

// ASKING AGAIN UNTIL SOMETHING HAS HAPPENED: a restart landing, a payment going through, a start finishing. One clock
// per wait, never two checks at once, an end (the check says done, or the deadline passes), and a check the moment the
// window is looked at again: a hidden tab's interval is throttled to a minute or more, so a reader coming back to it
// would otherwise wait out a stale rung before the page caught up. Given a `visible` source, a wait out of sight
// pauses instead. A wait on a query's own data is better said with vue-query's `refetchInterval` as a function
// (useHostedBuild.ts); this is for waits that span several reads, or whose query belongs to someone else.

export interface PollOptions {
    readonly everyMs: number;
    // One look. `true` ends the wait; anything else (a throw included) asks again on the next tick.
    readonly check: () => boolean | void | Promise<boolean | void>;
    // Look at once when the wait starts, rather than one period in. Defaults to true.
    readonly immediate?: boolean;
    // Whether the window is looked at, from a source that knows better than the document (the editor's onScreen: a
    // Windows webview hidden in the tray still reports itself visible). Given, the wait pauses while it is false (no
    // clock, no looks; the deadline still runs) and looks at once when it turns true. Without it, the document's
    // visibility, and a hidden tab keeps its throttled clock.
    readonly visible?: MaybeRefOrGetter<boolean>;
}

export interface Poll {
    readonly polling: Readonly<Ref<boolean>>;
    // Starts the wait, or moves an existing wait's deadline out to at least `forMs` from now; no `forMs` waits until
    // the check says done or `stop`.
    readonly start: (forMs?: number) => void;
    readonly stop: () => void;
}

type PollRun = { deadline: number; requested: boolean };

export const usePoll = ({ everyMs, check, immediate = true, visible }: PollOptions): Poll => {
    const run = shallowRef<PollRun>();
    const polling = computed(() => run.value !== undefined);
    let timer: ReturnType<typeof setInterval> | undefined;
    let looking = false;

    const stop = (): void => {
        clearInterval(timer);
        timer = undefined;
        run.value = undefined;
    };

    const look = async (): Promise<void> => {
        if (run.value === undefined) {
            return;
        }
        // A busy check holds one request for the current run, whether it came from start, focus or the clock.
        run.value.requested = true;
        if (looking) {return;}
        looking = true;
        try {
            while (run.value?.requested) {
                if (visible !== undefined && !toValue(visible)) {break;}
                const observed: PollRun = run.value;
                observed.requested = false;
                let done = false;
                try {
                    done = (await check()) === true;
                } catch {
                    // allow(silent-catch): a failed look is "not yet", which the next tick asks again; the check says why if it cares.
                }
                if (run.value === observed && (done || Date.now() > observed.deadline)) {stop();}
            }
        } finally {
            looking = false;
        }
    };

    const seen = (): boolean => (visible === undefined ? document.visibilityState === `visible` : toValue(visible));

    const runClock = (): void => {
        clearInterval(timer);
        timer = setInterval(() => void look(), everyMs);
    };

    const onReturn = (): void => {
        if (seen()) {
            void look();
        }
    };

    const start = (forMs?: number): void => {
        const deadline = forMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + forMs;
        if (run.value !== undefined) {
            run.value.deadline = Math.max(run.value.deadline, deadline);
            return;
        }
        run.value = { deadline, requested: false };
        // Out of sight: the clock and the first look wait for the window to come back.
        if (visible !== undefined && !toValue(visible)) {
            return;
        }
        runClock();
        if (immediate) {
            void look();
        }
    };

    if (visible === undefined) {
        document.addEventListener(`visibilitychange`, onReturn);
    } else {
        watch(
            () => toValue(visible),
            (shown) => {
                if (!polling.value) {
                    return;
                }
                if (shown) {
                    runClock();
                    void look();
                    return;
                }
                clearInterval(timer);
                timer = undefined;
            },
        );
    }
    window.addEventListener(`focus`, onReturn);
    if (getCurrentScope() !== undefined) {
        onScopeDispose(() => {
            stop();
            document.removeEventListener(`visibilitychange`, onReturn);
            window.removeEventListener(`focus`, onReturn);
        });
    }

    return { polling, start, stop };
};

// The same, asked for as long as `active` holds: started when it turns true, stopped when it turns false.
export const usePollWhile = (active: MaybeRefOrGetter<boolean>, options: PollOptions): Poll => {
    const poll = usePoll(options);
    watch(
        () => toValue(active),
        (on) => (on ? poll.start() : poll.stop()),
        { immediate: true },
    );
    return poll;
};
