import { computed } from "vue";
import { desktopApp } from "../../../../app/environments/desktop";
import { useSyncHealth } from "../../devices/useDevices";
import { useSandbox } from "../../client/useSandbox";

// Whether this sandbox's files exist in exactly one place, and whether the reader is sitting at a computer that
// could hold the second copy. Both halves are needed: the nudge is worth making only where acting on it is one
// click away, and saying it in a browser tab would be telling somebody about a feature they cannot reach.

export function useSandboxBackup() {
    const { active } = useSandbox();
    const { syncOffered, filesUnsynced } = useSyncHealth();

    // The desktop app announces itself on the window before the page loads, so this never changes mid-session.
    const onDesktop = computed(() => desktopApp() !== undefined);
    // A machine of the owner's already holds the files; only the cloud lane has nowhere else for them to be.
    const cloudOnly = computed(() => active.value?.hosted != null);

    return {
        onDesktop,
        cloudOnly,
        /** The whole condition the card and the attention row share, so they cannot appear apart. */
        unbacked: computed(() => onDesktop.value && cloudOnly.value && syncOffered.value && filesUnsynced.value),
    };
}
