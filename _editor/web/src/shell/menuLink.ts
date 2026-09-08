import type { MenuItem } from "primevue/menuitem";
import { type RouteLocationRaw, useRouter } from "vue-router";

// Builds a context-menu row's `url` and `command` from one destination, so they can't drift apart; @intentic/ui's
// <ContextMenu> owns no router, so resolution happens here. `after` (e.g. dismissing a popover) runs only on a
// plain click, not a modified one, which the browser sends to a new tab while this menu stays open.
export const useMenuLink = (): ((to: RouteLocationRaw, after?: () => void) => Pick<MenuItem, `url` | `command`>) => {
    const router = useRouter();
    return (to, after) => ({
        url: router.resolve(to).href,
        command: (): void => {
            after?.();
            void router.push(to);
        },
    });
};
