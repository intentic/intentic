import { getCurrentWindow } from "@tauri-apps/api/window";
import { onMounted, onUnmounted, ref, type Ref } from "vue";

/* WHETHER SOMETHING IS BEING DRAGGED OVER THIS WINDOW, for Home's drop zone to light up. The drop itself is the app's
   (windows.rs hands every dropped path to local.rs), so nothing here takes it, and nothing prevents a default. */

// Heard from two places, since neither reaches every drag. The app's own drag events are how a drag from the file
// manager reaches a window whose drops the app takes (Tauri's handler, on for this one), and on Windows the page
// hears nothing else. The page's DOM events are what a webview without that handler delivers: the dev server in a
// browser.
// A drag the page stopped hearing about (its dragleave lost on the way out of the window) goes dark after this long
// without a dragover, which a drag still over the page repeats every few hundred milliseconds even when it holds still.
const DRAG_IDLE_MS = 1000;

export const useDraggingOver = (): Ref<boolean> => {
    const over = ref(false);
    // dragenter and dragleave fire for every element the pointer crosses, so the page is only left once they balance.
    let depth = 0;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const carriesFiles = (event: DragEvent): boolean => event.dataTransfer?.types.includes(`Files`) === true;
    const onEnd = (): void => {
        clearTimeout(idle);
        depth = 0;
        over.value = false;
    };
    const onEnter = (event: DragEvent): void => {
        if (carriesFiles(event)) {
            depth += 1;
            over.value = true;
        }
    };
    const onOver = (event: DragEvent): void => {
        if (carriesFiles(event)) {
            over.value = true;
            clearTimeout(idle);
            idle = setTimeout(onEnd, DRAG_IDLE_MS);
        }
    };
    const onLeave = (event: DragEvent): void => {
        if (carriesFiles(event)) {
            depth = Math.max(0, depth - 1);
            over.value = depth > 0;
        }
    };

    let unlisten: (() => void) | undefined;
    let unmounted = false;
    onMounted(async () => {
        document.addEventListener(`dragenter`, onEnter);
        document.addEventListener(`dragover`, onOver);
        document.addEventListener(`dragleave`, onLeave);
        document.addEventListener(`drop`, onEnd);
        document.addEventListener(`dragend`, onEnd);
        try {
            const stop = await getCurrentWindow().onDragDropEvent(({ payload }) => {
                over.value = payload.type === `enter` || payload.type === `over`;
            });
            // A page gone before the listener landed must not leave it listening.
            if (unmounted) {
                stop();
                return;
            }
            unlisten = stop;
        } catch (error) {
            console.warn(`[home] the window's drag events cannot be heard, so the drop zone stays still:`, error);
        }
    });
    onUnmounted(() => {
        unmounted = true;
        unlisten?.();
        clearTimeout(idle);
        document.removeEventListener(`dragenter`, onEnter);
        document.removeEventListener(`dragover`, onOver);
        document.removeEventListener(`dragleave`, onLeave);
        document.removeEventListener(`drop`, onEnd);
        document.removeEventListener(`dragend`, onEnd);
    });
    return over;
};
