import type { NoticeModel } from "@intentic/ui";
import { noticeFrom, noticeOf } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import { passAskedTooSoon, passAskFrom, passLinkFor } from "./previewPassRules";

// A GUARDED PREVIEW'S PASS, for one Browsers tab's frame (previewPassRules.ts says the exchange). The frame's guarded
// page asks its parent for a pass; this answers with the daemon's one-time link to the same address, which the tab loads
// in the frame in place of the address, keying the frame on it, until the next reload or navigation settles it (a spent
// link opens nothing). The frame lands back where it was, holding the pass, and the address bar never shows the link.
// A generation counter, as the tab's probe has, drops an answer that arrives after the frame moved on.
//
// `frame` is the tab's own frame's window, the one source whose ask is taken; `previewUrl` the preview's public
// address, the one origin an ask may be about.
export function usePreviewPass(frame: () => MessageEventSource | null | undefined, previewUrl: () => string | undefined) {
    const link = ref<string | undefined>(undefined);
    // What the tab says about a pass it could not get, or one the browser did not keep.
    const notice = ref<NoticeModel | undefined>(undefined);
    let lastPassAt: number | undefined;
    let generation = 0;

    // The frame is moving on (a reload, a navigation): the link is spent and what was said is about the page it leaves.
    const settle = (): void => {
        generation += 1;
        link.value = undefined;
        notice.value = undefined;
    };
    // Another app or address: no pass this tab got says anything about the browser keeping one for it.
    const forget = (): void => {
        settle();
        lastPassAt = undefined;
    };

    // The preview in a tab of its own, through a pass of its own: the way on when this browser keeps no pass in a frame.
    // The tab is opened on the press itself, before the wait, so a popup blocker counts it as the person's, and cut from
    // this window, so the preview it lands on cannot steer the editor; it is sent on once the daemon answers.
    const openOwnTab = async (href: string): Promise<void> => {
        const opened = window.open(``, `_blank`);
        if (opened === null) {
            return;
        }
        opened.opener = null;
        try {
            const passed = passLinkFor((await sandboxRpc.ports.previewPass({ url: href })).url, href);
            if (passed === undefined) {
                opened.close();
                notice.value = noticeOf(t(`preview.previewPanel.passRefused`));
                return;
            }
            opened.location.href = passed;
        } catch (error) {
            opened.close();
            notice.value = noticeFrom(error, t(`preview.previewPanel.passRefused`));
        }
    };

    // The frame is back asking moments after a pass: the browser did not keep it (cookies blocked for the preview's site,
    // or in frames), and another would only bring it back again.
    const notKept = (href: string): NoticeModel => ({
        tone: `warning`,
        title: t(`preview.previewPanel.passNotKept`),
        detail: t(`preview.previewPanel.passNotKeptDetail`, { host: new URL(href).host }),
        action: { label: t(`preview.previewPanel.openOwnTab`), run: () => void openOwnTab(href) },
    });

    // A refusal (a guest's, an address the daemon does not own) is said in the daemon's words.
    const pass = async (href: string): Promise<void> => {
        const asked = ++generation;
        notice.value = undefined;
        try {
            const answer = await sandboxRpc.ports.previewPass({ url: href });
            if (asked !== generation) {
                return;
            }
            const passed = passLinkFor(answer.url, href);
            if (passed === undefined) {
                notice.value = noticeOf(t(`preview.previewPanel.passRefused`));
                return;
            }
            lastPassAt = Date.now();
            link.value = passed;
        } catch (error) {
            if (asked === generation) {
                notice.value = noticeFrom(error, t(`preview.previewPanel.passRefused`));
            }
        }
    };

    const onMessage = (event: MessageEvent): void => {
        const href = passAskFrom(event, frame(), previewUrl());
        if (href === undefined) {
            return;
        }
        if (passAskedTooSoon(lastPassAt, Date.now())) {
            notice.value = notKept(href);
            return;
        }
        void pass(href);
    };
    onMounted(() => {
        window.addEventListener(`message`, onMessage);
    });
    onUnmounted(() => {
        window.removeEventListener(`message`, onMessage);
        generation += 1;
    });

    return { link: computed(() => link.value), notice: computed(() => notice.value), settle, forget };
}
