import { computed, type ComputedRef, onUnmounted, ref, watch } from "vue";

// THE TWO FIGURES A SIGN-IN COUNTS, on one clock that ticks only while either is shown: how long a wait on the owner's
// machine has run (a wait that visibly counts is one that is still alive), and how long the attempt has left before it
// stops being answerable (the daemon's own `expiresAt`, or the poll's deadline for a subscription), so a timeout never
// arrives out of nowhere.

// Under this, the expiry is close enough to say on every step, not only beside a device code.
const EXPIRY_NEAR_MS = 5 * 60_000;

const clockWords = (ms: number): string => {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, `0`)}`;
};

export interface SignInClock {
    // "0:12" since the wait began, while there is one.
    readonly waited: ComputedRef<string | undefined>;
    // "14:52" until the attempt expires, where it says when.
    readonly expiry: ComputedRef<string | undefined>;
    readonly expiryNear: ComputedRef<boolean>;
}

export const useSignInClock = (expiresAt: () => number | undefined, waitingSince: () => number | undefined): SignInClock => {
    const clock = ref(Date.now());
    let ticking: ReturnType<typeof setInterval> | undefined;
    watch(
        () => expiresAt() !== undefined || waitingSince() !== undefined,
        (counting) => {
            clearInterval(ticking);
            ticking = counting ? setInterval(() => (clock.value = Date.now()), 1000) : undefined;
            clock.value = Date.now();
        },
        { immediate: true },
    );
    onUnmounted(() => clearInterval(ticking));

    const left = computed(() => {
        const at = expiresAt();
        return at === undefined ? undefined : at - clock.value;
    });
    return {
        waited: computed(() => {
            const since = waitingSince();
            return since === undefined ? undefined : clockWords(clock.value - since);
        }),
        expiry: computed(() => (left.value === undefined ? undefined : clockWords(left.value))),
        expiryNear: computed(() => left.value !== undefined && left.value < EXPIRY_NEAR_MS),
    };
};
