import { z } from "zod";

// What the desktop app's `window` CustomEvents carry into a local window (app/environments/local.ts names them), read
// back off a detail that crossed a process boundary: a shape this page has no answer for is nothing, never a guess.

const OpenDetail = z.object({ path: z.string().min(1) });

/** The entry an `intentic:open` names, relative to the window's folder; nothing for a detail of any other shape. */
export const openedPath = (event: Event): string | undefined => {
    if (!(event instanceof CustomEvent)) {
        return undefined;
    }
    const detail = OpenDetail.safeParse(event.detail);
    return detail.success ? detail.data.path : undefined;
};

const NavigateDetail = z.object({ path: z.string().startsWith(`/`) });

/** The route an `intentic:navigate` names (`/device`), for the local shell to take; nothing for any other shape. */
export const navigatedPath = (event: Event): string | undefined => {
    if (!(event instanceof CustomEvent)) {
        return undefined;
    }
    const detail = NavigateDetail.safeParse(event.detail);
    return detail.success ? detail.data.path : undefined;
};
