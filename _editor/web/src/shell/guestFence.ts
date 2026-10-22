import { watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { selfAgents } from "../client/sandbox/useMembers";
import { useRole } from "../client/sandbox/useRole";
import { guestFenceOf } from "../lib/routes/guestPaths";

// Keeps a guest member on the screens the daemon answers it on (guestPaths.ts). The tier arrives after the first paint
// (the summary loads, then corrects a default of owner), so a watch and not a guard: the redirect has to fire when
// the role lands, not only when the route changes. Which kind of guest it is (its assistants, or its home alone) arrives
// later still, from its own access read, and nothing moves until it has: fenced as the wrong kind first, a home-only
// guest would be sent to a chat it cannot open and then back.
export const useGuestFence = (): void => {
    const route = useRoute();
    const router = useRouter();
    const { isGuest, homeOnly } = useRole();
    const agents = selfAgents();
    watch(
        [() => route.path, isGuest, homeOnly, agents],
        ([path, guest, home, known]) => {
            if (!guest || known === undefined) {
                return;
            }
            const fence = guestFenceOf(home);
            if (!fence.allowed(path)) {
                void router.replace(fence.home);
            }
        },
        { immediate: true },
    );
};
