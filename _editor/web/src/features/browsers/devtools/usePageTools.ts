import type { BrowserRecording } from "@intentic/sandbox-contract/schemas/browser-tools";
import type { BrowserPage } from "@intentic/sandbox-contract/schemas/terminal";
import { errorMessage } from "@intentic/base/errors";
import { ref, type Ref, shallowRef, watch } from "vue";
import type { WindowToolsSeams } from "../windowTools";
import { devtoolsFrameSrc } from "./devtoolsAddress";

// What the browser's menu and its shortcuts do to the page in front: print it to a PDF (listed with the downloads,
// which open to show it), open its source in a tab beside it, Chromium's own DevTools for it, docked under the picture
// (DevToolsPanel.vue), and recording the window's picture, stopped from the same place and listed with the downloads.
// DevTools follows the tab in front, as a browser's does; another window closes it.

export const usePageTools = (
    seams: WindowToolsSeams,
    input: {
        readonly window: Ref<string | undefined>;
        readonly page: Ref<BrowserPage | undefined>;
        readonly usable: Ref<boolean>;
        // The window's recording under way, as its state says; undefined when none is.
        readonly recording: Ref<BrowserRecording | undefined>;
        readonly showDownloads: () => void;
    },
) => {
    const devtools = shallowRef<{ readonly src: string; readonly pageId: string } | undefined>();
    const error = ref<string | undefined>();
    const onPage = async (work: (name: string, pageId: string) => Promise<void>): Promise<void> => {
        const name = input.window.value;
        const page = input.page.value;
        if (name === undefined || page === undefined || !input.usable.value) {
            return;
        }
        error.value = undefined;
        try {
            await work(name, page.id);
        } catch (caught) {
            error.value = errorMessage(caught);
        }
    };
    const openDevtools = (): Promise<void> =>
        onPage(async (name, pageId) => {
            const src = devtoolsFrameSrc(seams.base(), await seams.browser.devtools({ name, pageId }));
            devtools.value = src === undefined ? undefined : { src, pageId };
        });
    watch([() => input.page.value?.id, input.window], ([pageId, name], [, before]) => {
        const shown = devtools.value;
        if (shown === undefined) {
            return;
        }
        if (name !== before || pageId === undefined) {
            devtools.value = undefined;
        } else if (pageId !== shown.pageId) {
            void openDevtools();
        }
    });
    return {
        devtools,
        error,
        print: (): Promise<void> =>
            onPage(async (name, pageId) => {
                await seams.browser.printPage({ name, pageId });
                input.showDownloads();
            }),
        viewSource: (): Promise<void> => onPage(async (name, pageId) => void (await seams.browser.viewSource({ name, pageId }))),
        recording: input.recording,
        // Records the window, or stops its recording and opens the downloads it is listed in.
        toggleRecording: (): Promise<void> =>
            onPage(async (name) => {
                if (input.recording.value === undefined) {
                    await seams.browser.startRecording({ name });
                    return;
                }
                await seams.browser.stopRecording({ name });
                input.showDownloads();
            }),
        toggleDevtools: (): void => {
            if (devtools.value === undefined) {
                void openDevtools();
            } else {
                devtools.value = undefined;
            }
        },
        closeDevtools: (): void => {
            devtools.value = undefined;
        },
    };
};

export type PageTools = ReturnType<typeof usePageTools>;
