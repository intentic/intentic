import { noteReload } from "@intentic/ui/reload-reason";
import { desktopWorkspace } from "./desktopWorkspace";
import { environment } from "./environment";
import { tellNative } from "./nativeApp";
import { NOTHING_TO_OPEN_PATH } from "./standAside";

// Where a signed-out reader goes: a full navigation, not a router push, since `afterSignOut` may point outside this SPA.
// The load it causes is the app's doing, not the reader's, so analytics is told why (reloadReason). Inside the Android
// app the app owns signing in, so it is told instead and takes the reader to its own sign-in screen (nativeApp.ts). The
// desktop app's workspace has no sign-in screen (features/auth/signInDialog.ts): its reader lands on Home's first run,
// which is useful without an account and has its Sign in on the rail.
export const leaveAfterSignOut = (): void => {
    if (tellNative({ kind: `signOut` })) {
        return;
    }
    noteReload(`sign-out`);
    globalThis.location.href = desktopWorkspace() ? NOTHING_TO_OPEN_PATH : environment.afterSignOut;
};
