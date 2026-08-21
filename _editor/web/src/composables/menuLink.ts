import type { MenuItem } from "primevue/menuitem";
import { type RouteLocationRaw, useRouter } from "vue-router";

/* A CONTEXT-MENU ROW THAT IS A PLACE, not a verb.
 *
 * <ContextMenu> renders its rows as anchors and honours `url`: the address the browser needs for its own
 * menu, for the status bar, for Ctrl/⌘-click and for middle-click, while `command` stays what an ordinary
 * click does. Both halves describe the same destination, so writing them apart is how they drift: a row would
 * keep pushing `/sandbox/status` long after the tab moved.
 *
 * <ContextMenu> lives in @intentic/ui, which deliberately owns no router (a UI kit that resolves app routes is
 * a UI kit only this app can use), so the resolution happens here, on the app side, and the kit is handed a
 * finished string.
 *
 * Spread it into the row and add the label and icon around it:
 *
 *     const link = useMenuLink();
 *     { label: `Connect / disconnect`, icon: `wifi`, ...link(`/sandbox/status`) }
 *
 * `after` is for the row that has TIDYING to do on its way out: dismissing the popover it was opened from:
 * and it runs on the plain click only. A modified click is answered by the browser opening another tab, and
 * closing the menu the user is still reading (and still clicking rows in) is not part of that. */
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
