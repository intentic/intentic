import type { BrowserDownload } from "@intentic/sandbox-contract/schemas/browser-tools";
import { errorMessage } from "@intentic/base/errors";
import { computed, ref, type Ref } from "vue";
import { rawRouteUrl } from "@intentic/sandbox-contract/protocol/raw/raw-routes";
import type { WindowToolsSeams } from "../windowTools";

// The window's download list (DownloadsButton.vue): its profile's downloads as the window's state carries them, and
// what each can be made into: a file on the person's own computer, a file in the workspace, a link, or nothing.

// What the last press on one download came to: where it was saved, or why it failed.
export interface DownloadSaid {
    readonly ok: boolean;
    readonly text: string;
}

export const useDownloadTools = (seams: WindowToolsSeams, list: Ref<readonly BrowserDownload[] | undefined>) => {
    const open = ref(false);
    const said = ref<Readonly<Record<string, DownloadSaid>>>({});
    const say = (id: string, ok: boolean, text: string): void => {
        said.value = { ...said.value, [id]: { ok, text } };
    };
    const pressing = async (id: string, press: () => Promise<void>): Promise<void> => {
        try {
            await press();
        } catch (error) {
            say(id, false, errorMessage(error));
        }
    };
    return {
        open,
        list: computed(() => list.value ?? []),
        said,
        // Through the person's own browser's download manager, which streams it to disk: nothing is held in the tab.
        toComputer: (download: BrowserDownload) =>
            pressing(download.id, async () => {
                const base = seams.base();
                if (base === undefined || base === ``) {
                    throw new Error(`The sandbox has no address yet.`);
                }
                const { ticket } = await seams.browser.downloadTicket({ id: download.id });
                seams.hand(`${base}${rawRouteUrl(`GET /browser/downloads/file`)}?${new URLSearchParams({ ticket }).toString()}`);
            }),
        toWorkspace: (download: BrowserDownload, folder: string | undefined) =>
            pressing(download.id, async () => {
                const saved = await seams.browser.saveDownload(folder === undefined ? { id: download.id } : { id: download.id, folder });
                say(download.id, true, saved.path);
            }),
        copyLink: (download: BrowserDownload) => pressing(download.id, () => seams.copy(download.url)),
        cancel: (download: BrowserDownload) => pressing(download.id, async () => void (await seams.browser.cancelDownload({ id: download.id }))),
        remove: (download: BrowserDownload) => pressing(download.id, async () => void (await seams.browser.removeDownload({ id: download.id }))),
    };
};

export type DownloadTools = ReturnType<typeof useDownloadTools>;
