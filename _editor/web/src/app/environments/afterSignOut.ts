import { noteReload } from "@intentic/ui/reload-reason";
import { environment } from "./environment";

// Where a signed-out reader goes: a full navigation, not a router push, since `afterSignOut` may point outside this SPA.
// The load it causes is the app's doing, not the reader's, so analytics is told why (reloadReason).
export const leaveAfterSignOut = (): void => {
    noteReload(`sign-out`);
    globalThis.location.href = environment.afterSignOut;
};
