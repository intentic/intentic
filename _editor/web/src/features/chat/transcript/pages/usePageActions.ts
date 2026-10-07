import type { Page } from "@intentic/sandbox-contract";
import { ref } from "vue";
import { sandboxRpc } from "../../../../client/sandbox/sandboxRpc";
import { usePaneView } from "../../panel/useChat-view";
import { focusComposer } from "../../tabs/useChat-tabs";
import { useChatSurface } from "../../tools/chatToolSurface";
import { setHtmlPreviewed } from "../../../workspace/viewers/html/htmlPreviewed";

// What a reader can do with a page the agent showed, beyond using it: open it full size in the file viewer, put it on
// the internet through the outbox, and take the words a button on it offered into the composer.

export const usePageActions = (page: () => Page) => {
    const { conversation } = usePaneView();
    const surface = useChatSurface();

    // A page's "Build this one" lands in the composer, never sent on the page's say-so: the reader presses Send.
    const message = (text: string): void => {
        const draft = conversation.value.draft.value.trim();
        conversation.value.draft.value = draft === `` ? text : `${draft}\n\n${text}`;
        focusComposer();
    };

    // Full size in the file viewer, rendered rather than as source.
    const expand = (): void => {
        setHtmlPreviewed(page().path, true);
        surface.openFile?.(page().path);
    };

    const publishing = ref(false);
    const published = ref<{ readonly url?: string; readonly path: string }>();
    const publishFailed = ref<string>();
    // Copies the stored page into the outbox; its address goes on the clipboard where there is one.
    const publish = async (): Promise<void> => {
        publishing.value = true;
        publishFailed.value = undefined;
        try {
            const result = await sandboxRpc.public.publish({ path: page().path });
            published.value = result;
            if (result.url !== undefined) {
                await navigator.clipboard?.writeText(result.url).catch(() => undefined);
            }
        } catch (error) {
            publishFailed.value = error instanceof Error ? error.message : String(error);
        } finally {
            publishing.value = false;
        }
    };

    return { message, expand, canExpand: surface.openFile !== undefined, publish, publishing, published, publishFailed };
};
