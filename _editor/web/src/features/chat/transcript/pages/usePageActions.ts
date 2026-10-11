import type { Page, PublishResult } from "@intentic/sandbox-contract";
import { writeClipboard } from "@intentic/ui/clipboard";
import { t } from "@intentic/ui/i18n";
import { computed } from "vue";
import { sandboxRpc } from "../../../../client/sandbox/sandboxRpc";
import { useOperation } from "../../../../workbench/operations/operations";
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

    // The page's, not this drawing of it: a transcript re-drawn while the copy is out (the pane closed, the chat
    // reopened) still holds the button, and its answer is still said beside it.
    const publishing = useOperation<PublishResult>(
        () => `chat/${conversation.value.conversationId}/pages/${page().id}/publish`,
    );
    // Copies the stored page into the outbox; its address goes on the clipboard where there is one.
    const publish = async (): Promise<void> => {
        const { path, title } = page();
        await publishing.run({
            what: t(`chat.chatPages.publishing`, { title }),
            failed: t(`chat.chatPages.publishFailed`),
            done: (result) => (result.url === undefined ? t(`chat.chatPages.publishedNoAddress`, { path: result.path }) : t(`chat.chatPages.publishedCopied`)),
            task: async () => {
                const result = await sandboxRpc.public.publish({ path });
                if (result.url !== undefined) {
                    await writeClipboard(result.url);
                }
                return result;
            },
        });
    };

    return {
        message,
        expand,
        canExpand: surface.openFile !== undefined,
        publish,
        publishing: publishing.busy,
        published: publishing.value,
        // The cause, for the hover on the line that says it failed.
        publishFailed: computed(() => publishing.failure.value && (publishing.failure.value.detail ?? publishing.failure.value.title)),
    };
};
