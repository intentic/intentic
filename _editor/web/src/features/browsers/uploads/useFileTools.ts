import type { BrowserFileChooser } from "@intentic/sandbox-contract/schemas/browser-tools";
import { errorMessage } from "@intentic/base/errors";
import { computed, ref, type Ref, shallowRef } from "vue";
import type { WindowToolsSeams } from "../windowTools";

// The person's own files for a page: picked for the page's file chooser (FileChooserCard.vue), or dropped on it from
// the desktop (useDropFiles.ts). Either way each goes up to the daemon first, under an id of its own, and the page is
// then handed the ids.

// One file on its way up, as the card lists it.
export interface Sending {
    readonly name: string;
    readonly size: number;
    readonly sent: number;
}

export const filesOf = (list: Iterable<File> | null | undefined): File[] => (list === null || list === undefined ? [] : [...list]);

export const useFileTools = (seams: WindowToolsSeams, window: Ref<string | undefined>, asked: Ref<BrowserFileChooser | undefined>) => {
    const sending = shallowRef<readonly Sending[]>([]);
    const error = ref<string | undefined>();

    // Sends each file up, saying its progress as it goes; answers their ids, in order.
    const send = async (files: readonly File[]): Promise<string[]> => {
        let rows = files.map((file): Sending => ({ name: file.name, size: file.size, sent: 0 }));
        sending.value = rows;
        const ids: string[] = [];
        for (const [index, file] of files.entries()) {
            const id = seams.uploadId();
            await seams.upload(file, id, (sent) => {
                rows = rows.map((row, at) => (at === index ? { ...row, sent } : row));
                sending.value = rows;
            });
            ids.push(id);
        }
        return ids;
    };

    // Runs one hand-over, its failure said on the card and its progress cleared either way.
    const handing = async (work: () => Promise<void>): Promise<void> => {
        error.value = undefined;
        try {
            await work();
        } catch (caught) {
            error.value = errorMessage(caught);
        } finally {
            sending.value = [];
        }
    };

    // Several files only where the page takes several; none is the picker closed, which the page hears as a cancel.
    const answer = (chooser: BrowserFileChooser, files: readonly File[]): Promise<void> =>
        handing(async () => {
            const name = window.value;
            if (name === undefined) {
                return;
            }
            const uploads = files.length === 0 ? [] : await send(chooser.multiple ? files : files.slice(0, 1));
            await seams.browser.answerFileChooser({ name, chooser: chooser.id, uploads });
        });

    return {
        chooser: computed(() => asked.value),
        sending,
        error,
        send,
        handing,
        pick: (chooser: BrowserFileChooser, list: Iterable<File> | null) => answer(chooser, filesOf(list)),
        cancel: (chooser: BrowserFileChooser) => answer(chooser, []),
    };
};

export type FileTools = ReturnType<typeof useFileTools>;
