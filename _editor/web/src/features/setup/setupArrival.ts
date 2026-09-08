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
    // Row has history (redeemed, reported, checked in, provisioned); an unfinished errand this page must not act on.
    readonly touched: boolean;
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

export const arrivalFor = (input: ArrivalInput): Arrival => {
    // An errand in progress, or a reader sent here to look at options; neither is a blank first arrival.
    if (input.touched || input.elsewhere) {
        return `choose`;
    }
    // Reader's own click, but `hosted` still must be takeable; `mine` always lands on `choose`, even in the app.
    if (input.requestedMachine !== undefined) {
        return input.requestedMachine === `hosted` && hostedTakeable(input) ? `hosted` : `choose`;
    }
    // In the app, the machine is this window's own; gated on minting addresses, since it redeems a setup code.
    if (input.inApp) {
        return input.commandOffered ? `local` : `choose`;
    }
    // In a browser, hosted only when takeable and this arrival made the row, so a stale reload spends nothing.
    return input.fresh && hostedTakeable(input) ? `hosted` : `choose`;
};
