import { getCurrentScope, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter, type Ref } from "vue";

// ASKING AGAIN UNTIL SOMETHING HAS HAPPENED: a restart landing, a payment going through, a start finishing. One clock
// per wait, never two checks at once, an end (the check says done, or the deadline passes), and a check the moment the
// window is looked at again: a hidden tab's interval is throttled to a minute or more, so a reader coming back to it
// would otherwise wait out a stale rung before the page caught up. A wait on a query's own data is better said with
// vue-query's `refetchInterval` as a function (useHostedBuild.ts); this is for waits that span several reads, or whose
// query belongs to someone else.

export interface PollOptions {
    readonly everyMs: number;
    // One look. `true` ends the wait; anything else (a throw included) asks again on the next tick.
    readonly check: () => boolean | void | Promise<boolean | void>;
    // Look at once when the wait starts, rather than one period in. Defaults to true.
    readonly immediate?: boolean;
}

export interface Poll {
    readonly polling: Readonly<Ref<boolean>>;
    // Starts the wait, or moves an existing wait's deadline out to at least `forMs` from now; no `forMs` waits until
    // the check says done or `stop`.
    readonly start: (forMs?: number) => void;
    readonly stop: () => void;
}

export const usePoll = ({ everyMs, check, immediate = true }: PollOptions): Poll => {
    const polling = ref(false);
    let timer: ReturnType<typeof setInterval> | undefined;
    let deadline = 0;
    let looking = false;

    const stop = (): void => {
        clearInterval(timer);
        timer = undefined;
        deadline = 0;
        polling.value = false;
    };

    const look = async (): Promise<void> => {
        if (!polling.value || looking) {
            return;
        }
        looking = true;
        let done = false;
        try {
            done = (await check()) === true;
        } catch {
            // allow(silent-catch): a failed look is "not yet", which the next tick asks again; the check says why if it cares.
        } finally {
            looking = false;
        }
        if (polling.value && (done || Date.now() > deadline)) {
            stop();
        }
    };

    const onReturn = (): void => {
        if (document.visibilityState === `visible`) {
            void look();
        }
    };

    const start = (forMs?: number): void => {
        deadline = Math.max(deadline, forMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + forMs);
        if (polling.value) {
            return;
        }
        polling.value = true;
        timer = setInterval(() => void look(), everyMs);
        if (immediate) {
            void look();
        }
    };

    document.addEventListener(`visibilitychange`, onReturn);
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
