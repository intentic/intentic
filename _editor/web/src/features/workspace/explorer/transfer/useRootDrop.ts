import { onScopeDispose, ref } from "vue";
import { useUploadQueue } from "../../files/upload/useUploadQueue";
import { filesOffered, watchDragSource } from "./dragSource";

// THE FLOOR OF A FILE SURFACE: OS files dropped anywhere on it that no row, tile or crumb took for itself land in one
// folder, the one its explorer is rooted at. Rows and the home's tiles take their own drops and stop them there; this
// catches the rest, which on an empty folder is every drop there is. The workspace's desktop wears it, and so does a
// desktop window on a folder of this computer (local/LocalFiles.vue): a surface without it refuses whatever misses a row.

export interface RootDropOptions {
    // Where a drop no row took lands.
    readonly targetDir: () => string;
    // Whether this surface takes files at all. One that doesn't answers with the no-drop cursor and draws no hint.
    readonly accepts?: () => boolean;
    // The last word, at the drop itself: true refuses it (the workspace's read-only tier, which says why as it refuses).
    readonly refuse?: () => boolean;
}

export const useRootDrop = (options: RootDropOptions) => {
    const { enqueueFromDataTransfer } = useUploadQueue();
    const accepts = options.accepts ?? ((): boolean => true);

    // The hint drawn over the surface while files are over it; an enter/leave depth stops the crossing of child elements
    // from flickering it off.
    const rootDragging = ref(false);
    let depth = 0;
    const reset = (): void => {
        depth = 0;
        rootDragging.value = false;
    };
    const onRootDragEnter = (event: DragEvent): void => {
        if (!filesOffered(event) || !accepts()) {
            return;
        }
        depth += 1;
        rootDragging.value = true;
    };
    const onRootDragLeave = (): void => {
        depth -= 1;
        if (depth <= 0) {
            reset();
        }
    };
    // Always taken, so the platform never opens a dropped file in place of the page (and its unsaved edits with it).
    const onRootDragOver = (event: DragEvent): void => {
        event.preventDefault();
        if (event.dataTransfer !== null && filesOffered(event)) {
            event.dataTransfer.dropEffect = accepts() ? `copy` : `none`;
        }
    };
    const onRootDrop = (event: DragEvent): void => {
        event.preventDefault();
        const files = filesOffered(event);
        reset();
        if (event.dataTransfer === null || !files || !accepts() || options.refuse?.() === true) {
            return;
        }
        // Synchronous: webkitGetAsEntry needs the drop's items alive, and the queue shows its scan at once.
        enqueueFromDataTransfer(options.targetDir(), event.dataTransfer);
    };

    // Who started a drag (dragSource.ts), so an image or a link dragged inside the page is never read as files.
    const unwatchDragSource = watchDragSource();
    // A row's own drop stops propagation; the window resets in the capture phase, before that, so the hint never sticks.
    window.addEventListener(`drop`, reset, true);
    window.addEventListener(`dragend`, reset, true);
    onScopeDispose(() => {
        unwatchDragSource();
        window.removeEventListener(`drop`, reset, true);
        window.removeEventListener(`dragend`, reset, true);
    });

    return { rootDragging, onRootDragEnter, onRootDragOver, onRootDragLeave, onRootDrop };
};
