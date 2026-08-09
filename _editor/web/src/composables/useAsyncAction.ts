import type { NoticeModel, NoticeTone } from "@intentic/ui/notice";
import { ref } from "vue";

/* The one shape every user-facing mutation reports through: a busy flag + a surfaced notice. Errors are
 * surfaced, not thrown — a failed daemon call (denylist 404, escape 400, oversize 413) shouldn't blow up the
 * DOM handler that fired it. Re-entry while busy is a no-op, so a double-click can't fire an action twice. */

// The thrown thing's message, for the places that need a STRING rather than something to show a user: an IPC
// reply's `error` field, a log line, an upload item's own record. Anything a person reads goes through
// `noticeFrom` below instead.
export const errorMessage = (error: unknown, fallback: string): string =>
    typeof error === `object` && error !== null && `message` in error && typeof error.message === `string` && error.message !== ``
        ? error.message
        : fallback;

interface NoticeOptions {
    readonly tone?: NoticeTone;
    readonly action?: NoticeModel[`action`];
    readonly key?: string;
}

/* A CAUGHT THING, TURNED INTO SOMETHING A PERSON CAN READ.
 *
 * `wrote` is the app's own sentence, and it is REQUIRED — that is the whole change. It used to be a fallback,
 * reached only when the throw carried no message of its own, which meant the COMMON path put our internals in
 * front of the user: "fetch failed", a bare 413, a line of git porcelain. The caller knows what the user was
 * trying to do and the throw site does not, so the caller's words are the headline and the raw message drops
 * to `detail`, where it is evidence rather than the message.
 *
 * The detail is dropped entirely when it says nothing the title doesn't — a line repeating the sentence above
 * it is noise wearing the costume of precision. */
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

// A notice with no throw behind it — a refusal the app itself decided (nothing selected, a name already taken,
// a running source that has to stop first).
export const noticeOf = (wrote: string, options: NoticeOptions = {}): NoticeModel => ({
    tone: options.tone ?? `danger`,
    title: wrote,
    action: options.action,
    key: options.key,
});

export function useAsyncAction() {
    const busy = ref(false);
    const notice = ref<NoticeModel | undefined>(undefined);
    // `wrote` is required for the reason above: an action that cannot say what failed in the app's own voice
    // is an action that has not finished being written.
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
