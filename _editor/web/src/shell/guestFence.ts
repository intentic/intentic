import { watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useRole } from "../features/sandbox/secrets/useRole";
import { GUEST_HOME, guestAllowedPath } from "./guestPaths";

// Keeps a guest member on the screens the daemon answers it on (guestPaths.ts). The tier arrives after the first paint
// (the summary loads, then corrects a default of owner), so a watch and not a guard: the redirect has to fire when
// the role lands, not only when the route changes.
export const useGuestFence = (): void => {
    const route = useRoute();
    const router = useRouter();
    const { isGuest } = useRole();
    watch(
        [() => route.path, isGuest],
        ([path, guest]) => {
            if (guest && !guestAllowedPath(path)) {
                void router.replace(GUEST_HOME);
            }
        },
        { immediate: true },
    );
};
