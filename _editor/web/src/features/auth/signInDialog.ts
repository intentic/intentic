import type { NoticeModel } from "@intentic/ui";
import { readonly, ref } from "vue";
import type { LocationQuery, RouteLocationNormalized, RouteLocationRaw } from "vue-router";
import { tellSignedInOnThisComputer } from "../../app/environments/desktop";
import { desktopWorkspace } from "../../app/environments/desktopWorkspace";
import { useAuth } from "../../client/auth/useAuth";
import { HOME_PATH } from "../../lib/routes/firstScreens";
import { returnPath } from "../../lib/routes/signIn";
import { takeBrowserHandoffDestination, useBrowserHandoff } from "./browserHandoff";
import { readDesktopHandoff, redeemDesktopHandoff } from "./redeemHandoff";

/* THE DESKTOP APP'S SIGN-IN, OVER THE VIEW THE READER IS ON (2026-10-26). The workspace face used to send a reader with no
   session to /login, a screen of its own filling the window: from Home's Sign in, from Add sandbox, from any page that
   needs an account, and from a session that lapsed under the page they were reading. The app has no address bar and no
   back button, so what they had been looking at was simply gone, and a new reader met a wall before anything else, with
   "Back to This computer" as the only other way off it. Now each of those asks for a sign-in in a dialog over the view
   (SignInDialog.vue), and the reader stays where they were. The browser's hand-off comes back into the same dialog: the
   app tells a page that is already up to open `/desktop-auth/complete`, and that is taken here, in place, rather than on
   a screen that replaced the view for the two seconds it took.

   A browser keeps /login, where Google's own sign-in runs and where a new visitor arrives; local windows have no sign-in of
   their own (theirs is the app's, in the default browser). */

/** Why the dialog is up, which is all its words change by. */
export type SignInReason =
    /** A Sign in pressed, or a cold start with nowhere in particular to go. */
    | `asked`
    /** A page or an action that needs an account: it opens once the reader is signed in. */
    | `needed`
    /** The session ended under the page. */
    | `lapsed`;

export type SignInStage =
    /** The ways in, with why the last attempt did not sign in when it did not. */
    | { readonly kind: `choose`; readonly notice?: NoticeModel }
    /** The browser's hand-off, being redeemed. */
    | { readonly kind: `arriving` };

export interface SignInAsk {
    /** Where the reader goes once signed in: a plain path of this app (lib/routes/signIn.ts `returnPath`). */
    readonly returnTo: string;
    readonly reason: SignInReason;
    readonly stage: SignInStage;
}

/** What only the router can do, handed over by it (router/index.ts). */
export interface SignInHost {
    /** Into `destination` now that the window is signed in, through the guards a fresh arrival there would meet. */
    readonly enter: (destination: string) => Promise<void>;
    /** The whole page loaded again at `destination`. */
    readonly reload: (destination: string) => void;
}

// allow(module-state): the window's one sign-in ask, raised from the router, the root and the dialog alike
const asked = ref<SignInAsk | undefined>(undefined);

/** The ask on screen; undefined while there is none. */
export const signInAsk = readonly(asked);

// allow(module-state): the router's half, given once it is built
let host: SignInHost | undefined;

/** The router hands over its half; this module may not import it back (layers.json: features sit below the router). */
export const hostSignIn = (given: SignInHost): void => {
    host = given;
};

// Whether this page held an account and lost it (a lapse), and which account it held when a sign-in was asked for. Every
// module that keeps an account's state (the open conversations, the sandbox's tabs, the extensions it loaded) kept the old
// one's, so a page that lost its account, or signs in as another than it held, is entered by a fresh load at the
// destination rather than in place.
// allow(module-state): about this page's life, which a reload ends
let lostAnAccount = false;
// allow(module-state): as above
let heldWhenAsked: string | undefined;

/** Whether signing in now leaves this page holding state that belongs to some other account than the one signed in. */
const staleAccount = (): boolean => lostAnAccount || (heldWhenAsked !== undefined && heldWhenAsked !== useAuth().user.value?.id);

/** Up, or kept up with a new destination: a lapse already said stays said, and a hand-off being redeemed is not interrupted. */
export const askSignIn = (returnTo: string, reason: SignInReason): void => {
    if (reason === `lapsed`) {
        lostAnAccount = true;
    }
    heldWhenAsked = useAuth().user.value?.id ?? heldWhenAsked;
    const current = asked.value;
    if (current?.stage.kind === `arriving`) {
        return;
    }
    asked.value = { returnTo, reason: current?.reason === `lapsed` ? `lapsed` : reason, stage: { kind: `choose` } };
};

/** The dialog closed without signing in. The view behind a lapse belonged to the account that left, so that one gives way to Home's first run. */
export const dismissSignIn = (): void => {
    const current = asked.value;
    if (current === undefined || current.stage.kind === `arriving`) {
        return;
    }
    asked.value = undefined;
    useBrowserHandoff().cancel();
    if (current.reason === `lapsed`) {
        host?.reload(HOME_PATH);
    }
};

/** Signed in (by the dialog's emailed code, or the browser's hand-off): on to `destination`. */
export const signedIn = async (destination: string): Promise<void> => {
    asked.value = undefined;
    useBrowserHandoff().cancel();
    if (staleAccount()) {
        host?.reload(destination);
        return;
    }
    await host?.enter(destination);
};

/**
 * The browser's hand-off, taken over the view on screen. A window already signed in as the same account was only after a
 * fresh Google proof for a sandbox's own sign-in (SignInWall.vue), which the redemption hands to the wait it was for: it
 * says nothing unless that fails, and nobody moves.
 */
const arriveInPlace = async (query: LocationQuery, here: string): Promise<void> => {
    const before = asked.value;
    const heldBefore = useAuth().user.value?.id;
    heldWhenAsked = heldBefore ?? heldWhenAsked;
    const stay = { returnTo: before?.returnTo ?? `/`, reason: before?.reason ?? `asked` } as const;
    if (before !== undefined || heldBefore === undefined) {
        asked.value = { ...stay, stage: { kind: `arriving` } };
    }
    const taken = readDesktopHandoff(query);
    const refused = await redeemDesktopHandoff(taken);
    if (refused !== undefined || taken === undefined) {
        useBrowserHandoff().cancel();
        asked.value = { ...stay, stage: { kind: `choose`, notice: refused } };
        return;
    }
    // Read whether or not it is used, so a later hand-off does not find this one's.
    const stored = takeBrowserHandoffDestination();
    // Begun on This computer: the app redeemed it here out of sight (auth.rs `complete_path`), and the reader is still
    // there. This page stays on the view it shows, now signed in, and tells the app, whose folder waiting on the account
    // carries on. Nobody is moved: not to the folder, not to this page's root.
    const destination = taken.backToFolder ? here : stored;
    if (taken.backToFolder) {
        tellSignedInOnThisComputer();
    }
    if (before === undefined && heldBefore !== undefined && !staleAccount()) {
        useBrowserHandoff().cancel();
        return;
    }
    await signedIn(destination);
};

/** What the rule reads of the route asked for. */
type AskedRoute = Pick<RouteLocationNormalized, `name` | `query`>;
/** What it reads of the route on screen: where it is, and whether it is the shell's. */
interface ShownRoute {
    readonly fullPath: string;
    readonly matched: readonly { readonly path: string }[];
}

/** A view of the shell (rail, Home, a sandbox's pages), as opposed to the screens outside it that stand alone. */
const insideShell = (route: ShownRoute): boolean => route.matched[0]?.path === `/`;

const reasonFor = (returnTo: string, from: ShownRoute | undefined): SignInReason =>
    returnTo === `/` || returnTo === HOME_PATH || returnTo === from?.fullPath ? `asked` : `needed`;

/**
 * The workspace face's rule for every navigation to a screen of the sign-in (router/index.ts): /login, wherever it is asked
 * from (a guard, a link, a press), becomes the dialog over the view on screen, which stays; on a page with no view yet, or
 * one standing outside the shell, the dialog comes up over Home. The hand-off's landing, in a page already showing
 * something, is taken in place. `from` is undefined for the page's first navigation. Anywhere else this answers `true`.
 */
export const signInInPlace = (to: AskedRoute, from: ShownRoute | undefined): boolean | RouteLocationRaw => {
    if (!desktopWorkspace()) {
        return true;
    }
    if (to.name === `login`) {
        const named = to.query[`returnTo`];
        const returnTo = named === undefined && from !== undefined ? from.fullPath : returnPath(named);
        askSignIn(returnTo, reasonFor(returnTo, from));
        return from !== undefined && insideShell(from) ? false : HOME_PATH;
    }
    if (to.name === `desktop-auth-complete` && from !== undefined) {
        void arriveInPlace(to.query, from.fullPath);
        return false;
    }
    return true;
};
