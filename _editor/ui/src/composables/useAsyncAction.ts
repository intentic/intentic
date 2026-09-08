import type { NoticeModel, NoticeTone } from "../components/feedback/notice.js";
import { ref } from "vue";

// The one shape every user-facing mutation reports through: a busy flag plus a surfaced notice. Errors
// are surfaced, not thrown; re-entry while busy is a no-op.

// The thrown thing's message, for places that need a string rather than something to show a user. Anything
// a person reads goes through `noticeFrom` instead.
export const errorMessage = (error: unknown, fallback: string): string =>
    typeof error === `object` && error !== null && `message` in error && typeof error.message === `string` && error.message !== ``
        ? error.message
        : fallback;

interface NoticeOptions {
    readonly tone?: NoticeTone;
    readonly action?: NoticeModel[`action`];
    readonly key?: string;
}

// A caught thing turned into something a person can read. `wrote` is the app's own sentence and is
// required, so the caller's words are the headline and the raw message drops to `detail` as evidence.
// The detail is dropped when it repeats the title.
export const noticeFrom = (cause: unknown, wrote: string, options: NoticeOptions = {}): NoticeModel => {
    const raw = errorMessage(cause, ``);
    return {
        tone: options.tone ?? `danger`,
        title: wrote,
        detail: raw === `` || raw === wrote ? undefined : raw,
        action: options.action,
        key: options.key,
    };
};

// A notice with no throw behind it: a refusal the app itself decided.
export const noticeOf = (wrote: string, options: NoticeOptions = {}): NoticeModel => ({
    tone: options.tone ?? `danger`,
    title: wrote,
    action: options.action,
    key: options.key,
});

export function useAsyncAction() {
    const busy = ref(false);
    const notice = ref<NoticeModel | undefined>(undefined);
    // `wrote` is required for the same reason as above: an action that can't say what failed in the app's
    // own voice isn't finished being written.
    const run = async (task: () => Promise<void>, wrote: string): Promise<void> => {
        if (busy.value) {
            return;
        }
        notice.value = undefined;
        busy.value = true;
        try {
            await task();
        } catch (caught) {
            notice.value = noticeFrom(caught, wrote);
        } finally {
            busy.value = false;
        }
    };
    return { busy, notice, run };
}
