import type { NoticeModel } from "@intentic/ui/notice";
import { onScopeDispose, ref, watch, type Ref } from "vue";

/* WHEN A FAILURE IS ALLOWED TO BE SAID.
 *
 * The sibling of loadingReveal.ts ("when a wait is allowed to be SEEN"), and the same observation from the
 * other side: a poll that fails once and succeeds on the retry, and a poll that has stopped working, are not
 * the same event — but they look identical for the first second, and the app used to shout at both. A red box
 * that appears and vanishes teaches the user to distrust the quiet ones, which is the opposite of what an
 * error is for.
 *
 * So an ambient failure — one nobody clicked, that the app is already retrying — waits. If it heals inside the
 * grace it is never said at all; if it survives, it is said once and stays until it heals. The dwell is
 * deliberately longer than loadingReveal's: a spinner appearing early costs a flicker, an alarm appearing
 * early costs trust.
 *
 * NOT for the failure of something the user just pressed. A click is a question, and an answer that arrives a
 * second late has already been waited for — those report immediately, through useAsyncAction. The whole
 * distinction this module exists to draw is ambient vs asked-for.
 *
 * The notice keeps its IDENTITY across the wait: a source that changes what it is saying mid-grace (a
 * different fetch failing) restarts the clock, because that is a new claim and it has not survived anything
 * yet. Same title, same claim, one clock. */

// Two failed polls at a typical cadence, so a single dropped request never reaches the screen.
export const NOTICE_GRACE_MS = 4_000;

export const useNoticeGrace = (source: Ref<NoticeModel | undefined>, graceMs = NOTICE_GRACE_MS): Ref<NoticeModel | undefined> => {
    const said = ref<NoticeModel | undefined>(undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = (): void => {
        clearTimeout(timer);
        timer = undefined;
    };

    watch(
        source,
        (next, previous) => {
            if (next === undefined) {
                // Healed. Whether it was ever said or was still inside its grace, there is nothing to report.
                cancel();
                said.value = undefined;
                return;
            }
            // Already on screen: update the words in place rather than pulling the notice and re-arming, which
            // would blink a box the user is mid-sentence through.
            if (said.value !== undefined) {
                said.value = next;
                return;
            }
            if (timer !== undefined && previous?.title === next.title) {
                return;
            }
            cancel();
            timer = setTimeout(() => {
                said.value = next;
                timer = undefined;
            }, graceMs);
        },
        { immediate: true },
    );

    onScopeDispose(cancel);
    return said;
};
