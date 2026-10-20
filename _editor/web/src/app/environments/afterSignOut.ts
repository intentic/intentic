import { noteReload } from "@intentic/ui/reload-reason";
import { environment } from "./environment";
import { tellNative } from "./nativeApp";

// Where a signed-out reader goes: a full navigation, not a router push, since `afterSignOut` may point outside this SPA.
// The load it causes is the app's doing, not the reader's, so analytics is told why (reloadReason). Inside the Android
// app the app owns signing in, so it is told instead and takes the reader to its own sign-in screen (nativeApp.ts).
export const leaveAfterSignOut = (): void => {
    if (tellNative({ kind: `signOut` })) {
        return;
    }
    noteReload(`sign-out`);
    globalThis.location.href = environment.afterSignOut;
};
