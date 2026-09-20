import { watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useRole } from "../features/sandbox/secrets/useRole";
import { DESK_HOME, deskAllowedPath } from "./deskPaths";

// Keeps a desk member on the screens the daemon answers it on (deskPaths.ts). The tier arrives after the first paint
// (the summary loads, then corrects a default of owner), so a watch and not a guard: the redirect has to fire when
// the role lands, not only when the route changes.
export const useDeskFence = (): void => {
    const route = useRoute();
    const router = useRouter();
    const { isDesk } = useRole();
    watch(
        [() => route.path, isDesk],
        ([path, desk]) => {
            if (desk && !deskAllowedPath(path)) {
                void router.replace(DESK_HOME);
            }
        },
        { immediate: true },
    );
};
