import type { SandboxSummary } from "@intentic/api-contract";
import { projectDirNameFor } from "@intentic/sandbox-contract";
import type { LocationQueryValue } from "vue-router";

// Decides, in one place, what arriving on /setup does by itself: the desktop app hands the setup code to itself;
// a browser starts a hosted machine, and so does a project wherever the platform's machines can hold one. The picker
// survives only when a surface's own answer is unavailable or refused. `Arrival` is the action taken on arrival, not
// what the page renders.

// A PROJECT SETUP: the desktop app opens this page as `/setup?project=<folder name>` for a folder the reader picked on
// their computer, and keeps the folder's path to itself. The page only ever needs its name.
export interface SetupProject {
    // The folder's own name, which a sandbox made for it is called.
    readonly name: string;
    // Where the folder lands in the sandbox (`/work/<dirName>`), derived once, here, and only validated after.
    readonly dirName: string;
}

// One key of a query as vue-router hands it back: an array for a repeated key, null for a bare `?key`.
type QueryValue = LocationQueryValue | LocationQueryValue[] | undefined;

const isSingle = (value: QueryValue): value is string => typeof value === `string`;

// `?project=` read back as a project, or nothing: a blank value names no folder, and a repeated one no single folder.
export const setupProjectOf = (value: QueryValue): SetupProject | undefined => {
    const name = isSingle(value) ? value.trim() : ``;
    return name === `` ? undefined : { name, dirName: projectDirNameFor(name) };
};

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
    // A project setup (`setupProjectOf`): the folder is on this computer and only the app can hand it to a sandbox.
    readonly project: boolean;
    // The platform's machines can hold a project (`hostedOffer.projects`); false on a platform from before them.
    readonly hostedProjects: boolean;
}

// Whether there's a machine to give: platform hosts, isn't full, and this account's allowance isn't spent. Shared
// so the explicit ask and the browser default never disagree.
const hostedTakeable = (input: ArrivalInput): boolean => input.hostedOffered && !input.hostedSpent && !input.hostedFull;

// A project's rung, where the platform's machines can hold one: a machine of ours, which the app copies the folder into
// once it runs, whenever one can be started for this row and the reader did not ask for this computer. The picker
// preselects it even where the arrival starts nothing (a row found rather than made).
export const projectPrefersHosted = (input: ArrivalInput): boolean =>
    input.project && input.hostedProjects && input.requestedMachine !== `mine` && !input.hostedIdle && hostedTakeable(input);

// A project's arrival. A machine of ours when the platform can give it one: started for a row this visit made or a
// rung asked for by name, preselected otherwise. A machine already on the row is this folder's, still coming up, and
// is resumed rather than handed back. Anything else goes to this computer, as every project did before the platform's
// machines could hold one, wherever a code can be minted for the app to redeem.
const projectArrival = (input: ArrivalInput): Arrival => {
    if (projectPrefersHosted(input)) {
        return input.fresh || input.requestedMachine === `hosted` ? `hosted` : `choose`;
    }
    if (input.hostedProjects && input.hostedIdle && input.requestedMachine !== `mine`) {
        return `choose`;
    }
    return input.commandOffered ? `local` : `choose`;
};

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
    // The folder already answered where it runs, however many sandboxes the account has, and from a browser too (its
    // setup link reaches the app by the OS).
    if (input.project) {
        return projectArrival(input);
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

// A row with history: redeemed, reported on, or checked in. Finding a row again (a reload, a reopened tab, the app's
// first frame) is not history, since a row exists from the moment /setup opens; only genuine acts count.
export const touched = (row: SandboxSummary): boolean =>
    // `?? null` on each: fields are optional as well as nullable on older rows, and `undefined !== null` touches every row.
    (row.lastSeenAt ?? null) !== null || (row.setupCodeClaimedAt ?? null) !== null || (row.setupReport ?? null) !== null;

// A machine of ours on a row nothing has ever run on (`ArrivalInput.hostedIdle`).
export const hostedIdle = (row: SandboxSummary): boolean => (row.hosted ?? null) !== null && (row.lastSeenAt ?? null) === null;

// The row this visit works on: the one the URL names, else the account's single unfinished one while it has no working
// one; undefined, meaning a fresh draft, for anything that is not the owner's.
export const rowToOpen = (rows: readonly SandboxSummary[], named: string | undefined): SandboxSummary | undefined => {
    const requested = named === undefined ? undefined : rows.find((entry) => entry.id === named);
    const unfinished = rows.some((entry) => entry.lastSeenAt !== null)
        ? undefined
        : rows.find((entry) => entry.role === `owner` && entry.lastSeenAt === null);
    const found = requested ?? unfinished;
    return found?.role === `owner` ? found : undefined;
};
