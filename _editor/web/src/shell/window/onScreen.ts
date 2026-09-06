import { computed, type ComputedRef, ref } from "vue";

/* IS ANYONE LOOKING AT THIS WINDOW, the gate behind the "Updated" badge on a chat and behind reporting the
 * reader idle to everyone else on the sandbox.
 *
 * One document, this window's, which is worth a note only because it used to be a set of them. A floating panel
 * was DOM teleported into a second window while its JS stayed in the opener's realm, so `document` here was
 * always the opener's and said nothing about the window the user was actually reading: a chat read in a floating
 * window while the app's tab sat behind another one kept its badge, and the person typing in it was reported
 * idle, until they clicked back to the tab and both caught up at once. A floating panel runs its own copy of the
 * app now (composables/floating.ts), so every window answers this question for itself and about itself, and the
 * app's presence is the union of what its windows report to the daemon rather than something this file has to
 * assemble.
 *
 * A window buried under another window still calls itself visible: the browser says hidden for a minimized
 * window or a background tab, not for an occluded one. That is the approximation this gate wants, since a window
 * the user has on screen is one they can be reading. */

const visible = ref(true);

export const onScreen: ComputedRef<boolean> = computed(() => visible.value);

if (typeof document !== `undefined`) {
    const sync = (): void => {
        visible.value = document.visibilityState === `visible`;
    };
    document.addEventListener(`visibilitychange`, sync);
    sync();
}
