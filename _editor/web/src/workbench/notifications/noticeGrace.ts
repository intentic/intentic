import type { NoticeModel } from "@intentic/ui/notice";
import { onScopeDispose, ref, watch, type Ref } from "vue";

// Delays an ambient failure (one nobody clicked, already being retried) so it never shows if it heals within the
// grace period; a user-initiated failure reports immediately elsewhere (useAsyncAction). A source that changes its
// claim mid-grace restarts the clock.

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
                // Healed: clears whether it was already said or still inside its grace.
                cancel();
                said.value = undefined;
                return;
            }
            // Already on screen: update in place rather than re-arm, which would blink a box mid-read.
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
