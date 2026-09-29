import { onMounted, onUnmounted } from "vue";

/* THIS WINDOW IS HIDDEN, NEVER CLOSED (windows.rs `swap_in`): a page mounted once is shown again and again, and what
   it read on mount can be hours old by the time the tray brings it back. */

/** Runs `read` each time the window comes back to the reader: focused again, or its page turned visible again. */
export const useWhenShown = (read: () => void): void => {
    const onFocus = (): void => read();
    const onVisibility = (): void => {
        if (document.visibilityState === `visible`) {
            read();
        }
    };
    onMounted(() => {
        window.addEventListener(`focus`, onFocus);
        document.addEventListener(`visibilitychange`, onVisibility);
    });
    onUnmounted(() => {
        window.removeEventListener(`focus`, onFocus);
        document.removeEventListener(`visibilitychange`, onVisibility);
    });
};
