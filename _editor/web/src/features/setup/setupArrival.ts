// Decides, in one place, what arriving on /setup does by itself: the desktop app hands the setup code to itself;
// a browser starts a hosted machine. The picker survives only when a surface's own answer is unavailable or
// refused. `Arrival` is the action taken on arrival, not what the page renders.

export type Arrival =
    // Starts a machine on the platform's provider now and shows it booting; a browser's answer.
    | "hosted"
    // Hands the setup code to the surrounding app the moment it mints; the desktop app's answer.
    | "local"
    // Draws the picker (rungs, command, attach lane): the fallback when a surface has no answer, or was asked for.
    | "choose";

export interface ArrivalInput {
    readonly inApp: boolean;
    // Nothing else on this account: the app installing on this computer is the whole gesture of having just
    // installed the app. With a sandbox already somewhere, "add another" is a question only the reader can answer.
    readonly onlySandbox: boolean;
    // Row has history (redeemed, reported, checked in); an unfinished errand this page must not act on.
    readonly touched: boolean;
    // Row carries a machine of ours that nothing has ever run on: a browser's errand to resume, and in the app a
    // machine to hand back, since installing on this computer is the whole gesture of being in the app.
    readonly hostedIdle: boolean;
    // Minted by this arrival, not merely untouched; a machine starts only for a row made fresh this visit.
    readonly fresh: boolean;
    // The platform hosts sandboxes at all (`sandbox.hostedOffer`), and this account has an allowance left.
    readonly hostedOffered: boolean;
    readonly hostedSpent: boolean;
    // Platform fleet is at capacity with no warm stock, distinct from this account's own `hostedSpent` allowance.
    readonly hostedFull: boolean;
    // Whether the platform mints addresses for a pasted command or app handoff to redeem.
    readonly commandOffered: boolean;
    // Rung chosen before this page via `?machine=`; an explicit click outranks the surface's own guess either way.
    readonly requestedMachine: "hosted" | "mine" | undefined;
    // `?elsewhere=1`: this computer can't run it; the one app arrival that must not install anything.
    readonly elsewhere: boolean;
}

// Whether there's a machine to give: platform hosts, isn't full, and this account's allowance isn't spent. Shared
// so the explicit ask and the browser default never disagree.
const hostedTakeable = (input: ArrivalInput): boolean => input.hostedOffered && !input.hostedSpent && !input.hostedFull;

// Nothing this arrival may answer for itself: an errand already in progress, a reader sent here to read the
// options, or a machine already on the row — which is the browser's own errand to resume, but never the app's,
// since being in the app is the gesture of running it on this computer.
const settled = (input: ArrivalInput): boolean => input.touched || input.elsewhere || (input.hostedIdle && !input.inApp);

// The app answering with this computer: only for an account with nowhere else to put a sandbox, and only where a
// setup code can be minted for the install to redeem.
const installsHere = (input: ArrivalInput): boolean => input.commandOffered && input.onlySandbox;

export const arrivalFor = (input: ArrivalInput): Arrival => {
    if (settled(input)) {
        return `choose`;
    }
    // A row that already has a machine has nothing to start, whoever asked for it.
    const startable = !input.hostedIdle && hostedTakeable(input);
    // Reader's own click, but `hosted` still must be startable; `mine` always lands on `choose`, even in the app.
    if (input.requestedMachine !== undefined) {
        return input.requestedMachine === `hosted` && startable ? `hosted` : `choose`;
    }
    // In the app, the first machine is this window's own; gated on minting addresses, since it redeems a setup code.
    // Every later one asks, because by then this computer is one of the places it could go rather than the only one.
    if (input.inApp) {
        return installsHere(input) ? `local` : `choose`;
    }
    // In a browser, hosted only when takeable and this arrival made the row, so a stale reload spends nothing.
    return input.fresh && startable ? `hosted` : `choose`;
};
