import { type Ref, watch } from "vue";
import { useNotifications } from "../../../../workbench/notifications/notifications";

// A refused press (a land, an archive, a restore) is said as a toast in the app's notification lane, not as a strip
// across the board: a strip pushed the lanes down under the reader and sat there until dismissed. Raising it hands
// the message over, so the same refusal pressed twice toasts twice. `immediate`: one raised while the board was
// closed is said when it opens.
export const useNoticeToasts = (notice: Readonly<Ref<string | undefined>>, dismissNotice: () => void): void => {
    const { warn } = useNotifications();
    watch(
        notice,
        (message) => {
            if (message === undefined) {
                return;
            }
            warn(message);
            dismissNotice();
        },
        { immediate: true },
    );
};
