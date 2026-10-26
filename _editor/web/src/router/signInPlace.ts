import { noteReload } from "@intentic/ui/reload-reason";
import { type Router, START_LOCATION } from "vue-router";
import { hostSignIn, signInInPlace } from "../features/auth/signInDialog";
import { goInside } from "../lib/routes/homeDetour";
import { requireAuth } from "./sessionGuard";
import { openNamedSandbox, settleGate } from "./shellGates";

// THE DESKTOP APP ASKS FOR A SIGN-IN OVER THE VIEW, NEVER INSTEAD OF IT (features/auth/signInDialog.ts): /login, from a
// guard, a link or a press, becomes the dialog over what is on screen, and the browser's hand-off coming back to a page
// already up is taken there too. This binds that rule to the router, and gives the dialog the router's half: entering
// where the sign-in was going once it is done.

const insideShell = (matched: readonly { readonly path: string }[]): boolean => matched[0]?.path === `/`;

/** Installs the rule and the entry; index.ts calls it where the rule must stand among the other global guards. */
export const installSignInPlace = (router: Router): void => {
    router.beforeEach((to, from) => signInInPlace(to, from === START_LOCATION ? undefined : from));

    // A SIGN-IN TAKEN IN PLACE ENTERS ITS DESTINATION AS AN ARRIVAL WOULD. The shell's own guards ran for nobody when the
    // view behind the dialog was entered, and vue-router runs them again only for a navigation that enters the shell, never
    // for one inside it, so the one navigation `enter` starts asks them here, after the redirect it met (the bare address
    // to Home). A destination outside the shell meets its own guards.
    // allow(module-state): the one navigation in flight that a sign-in in place started
    let entering = false;
    router.beforeEach(async (to) => {
        if (!entering) {
            return true;
        }
        entering = false;
        for (const guard of [requireAuth, settleGate, openNamedSandbox]) {
            const answer = await guard(to);
            if (answer !== true) {
                return answer;
            }
        }
        return true;
    });

    const enter = async (destination: string): Promise<void> => {
        const target = router.resolve(destination);
        if (!insideShell(router.currentRoute.value.matched) || !insideShell(target.matched)) {
            await router.replace(destination);
            return;
        }
        entering = true;
        try {
            // Forced: the destination is often the very view behind the dialog, which a plain navigation would skip as a
            // duplicate without asking the guards. A sandbox's view is a step inside it, as a pick in the switcher is.
            await goInside(() => router.replace({ path: target.path, query: target.query, hash: target.hash, force: true }));
        } finally {
            entering = false;
        }
    };

    hostSignIn({
        enter,
        // A page that kept a lost account's state is entered afresh; the load is the app's doing, and analytics is told so.
        reload: (destination) => {
            noteReload(`sign-in`);
            globalThis.location.assign(router.resolve(destination).href);
        },
    });
};
