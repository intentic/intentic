import { computed, type ComputedRef, ref } from "vue";

// Whether this window's document is visible (document.visibilityState), gating the chat's "Updated" badge and idle
// reporting to the sandbox; each window answers for itself. An occluded but not minimized window still counts as
// visible, since the browser only reports hidden for a minimized window or a background tab.

const visible = ref(true);

export const onScreen: ComputedRef<boolean> = computed(() => visible.value);

if (typeof document !== `undefined`) {
    const sync = (): void => {
        visible.value = document.visibilityState === `visible`;
    };
    document.addEventListener(`visibilitychange`, sync);
    sync();
}
