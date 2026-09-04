/* WHAT ARRIVING ON /setup DOES BY ITSELF, decided in one pure place beside the page (the hostedWait.ts and
 * setupReport.ts pattern), because it is the decision the whole of onboarding used to hand to the reader.
 *
 * The page opened on a picker: three rungs, a paragraph of trade-offs behind each of them, and no way to
 * evaluate any of it, since the reader had signed up ninety seconds earlier and had not yet seen the product.
 * An infrastructure question with pricing attached is not a first screen. And it was never a real question in
 * the first place, because the surface the reader arrived on already answers it:
 *
 *   • THE DESKTOP APP is a computer the user owns, running a process that can install a sandbox on it. That
 *     is the whole reason they downloaded it. Asking "which machine?" inside it is asking somebody who walked
 *     into a room which room they would like to be in.
 *   • A BROWSER has no machine to offer. Everything it can do to somebody's computer needs a terminal or an
 *     installer first, and the platform can hand them a working sandbox in seconds instead, off a warm pool.
 *
 * So each surface takes its own answer, and the picker survives only for the cases where the surface's answer
 * is unavailable or has been refused. `Arrival` is that answer, and it is deliberately about the ACTION taken
 * on arrival rather than about what the page draws: a resumed machine that is still booting renders the same
 * boot card as a fresh one, and neither has anything to do with whether this visit started it. */

export type Arrival =
    // Start a machine on the platform's own provider now, and show the reader it booting. A browser's answer.
    | "hosted"
    // Hand the setup code to the app around this page the moment it mints. The desktop app's answer.
    | "local"
    // Draw the page: the rungs still on offer, the command, and the attach lane under them. What is left when
    // a surface's own answer cannot be taken, and what an explicit ask lands on.
    | "choose";

export interface ArrivalInput {
    // This page is being read INSIDE the desktop app's webview (environments/desktop.ts).
    readonly inApp: boolean;
    /* The row on screen has a HISTORY: a machine redeemed its code, reported on a run, checked in, or was
     * provisioned for it (Setup.vue's `touched`). Somebody's unfinished errand, so nothing here starts
     * anything: the way to finish it is the one they were already on, and quietly doing something else to
     * their sandbox is the one move a resumed setup must never make. */
    readonly touched: boolean;
    /* THE ROW WAS MINTED BY THIS ARRIVAL, seconds ago, by the page itself (Setup.vue's `createdHere`). The
     * other half of `touched`, and the half that was missing.
     *
     * `touched` asks whether anybody ever ACTED on this row, which is exactly the right question for a
     * half-finished install and exactly the wrong one for a row nobody ever did anything with. A visit that
     * opened /setup and closed the tab leaves such a row behind — untouched, and permanent — so every LATER
     * visit found it, read it as a blank first arrival, and started a machine on the platform's provider for
     * it. Measured on the live product: an account whose only sandbox was an abandoned draft from a fortnight
     * earlier was handed a machine by nothing more than opening app.intentic.dev, and, because a row with
     * hardware attached is no longer a draft, the machine then stayed.
     *
     * A machine is the one thing this page can start that costs the reader something (their one free
     * allowance, and a real box on somebody's provider), so it is started only for a row this visit made out
     * of nothing. Anything found lying here gets the picker, which is one click and says what it will do. */
    readonly fresh: boolean;
    // The platform hosts sandboxes at all (`sandbox.hostedOffer`), and this account has an allowance left.
    readonly hostedOffered: boolean;
    readonly hostedSpent: boolean;
    // The platform mints addresses, so a pasted command or an app handoff has something to redeem.
    readonly commandOffered: boolean;
    /* A rung chosen BEFORE this page, off `?machine=`: the public site's /where-it-runs cards link through
     * it. An explicit click outranks the surface's guess in both directions, "start instantly" from the site
     * starts one, and "set up on my computer" opens the step that does that rather than a machine nobody
     * asked for. */
    readonly requestedMachine: "hosted" | "mine" | undefined;
    /* `?elsewhere=1`, the link the app's own requirements screen offers when THIS computer cannot run it (no
     * WSL2, no Docker, a locked-down work laptop). The one arrival in the app that must not install anything:
     * it is a reader who has just been told this machine is not the one. */
    readonly elsewhere: boolean;
}

// Is there a machine of ours to give this account: the platform hosts, and the allowance is not already spent
// on some other sandbox. Its own predicate because both the explicit ask and the browser default gate on it,
// and they must never disagree about what "on offer" means.
const hostedTakeable = (input: ArrivalInput): boolean => input.hostedOffered && !input.hostedSpent;

export const arrivalFor = (input: ArrivalInput): Arrival => {
    // An errand in progress, or a reader who has just been sent here to look at their options. Both are
    // somebody who has already been shown something; neither is a blank first arrival to act on.
    if (input.touched || input.elsewhere) {
        return `choose`;
    }
    /* THE READER'S OWN CLICK, taken literally. `hosted` still has to be takeable, a cached site page is the
     * same HTML for every platform and can name a rung this one does not offer, which is why the guard is
     * here rather than trusted from the query. `mine` lands on `choose` rather than on `local`, even in the
     * app: it is a browser's word for "show me the install step", and the app's version of that step already
     * carries the button. */
    if (input.requestedMachine !== undefined) {
        return input.requestedMachine === `hosted` && hostedTakeable(input) ? `hosted` : `choose`;
    }
    /* INSIDE THE APP, the machine is the one this window is running on. Gated on the platform minting
     * addresses, because the app runs the same connect script the pasted command does and it redeems a setup
     * code: a platform with no fabric has nothing for it to redeem, and firing the handoff there would open
     * the app's install screen on a run that cannot finish. */
    if (input.inApp) {
        return input.commandOffered ? `local` : `choose`;
    }
    /* …and in a browser, the machine is ours, whenever there is one to give AND this arrival is the one that
     * made the row. `fresh` is what keeps the zero-click machine a property of ARRIVING for the first time
     * rather than of the row happening to look blank: without it, every reload of a draft nobody finished
     * spent an allowance and left a box running (see `fresh` above). A reader who does want one from here is
     * one labelled click away, on the picker `choose` draws. */
    return input.fresh && hostedTakeable(input) ? `hosted` : `choose`;
};
