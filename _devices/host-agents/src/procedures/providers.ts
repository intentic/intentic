import { type FixtureRouter, refuse } from "@intentic/contract-serve";
import { errorMessage } from "@intentic/base/errors";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { fetchAdapter, harnessState } from "../engines.js";
import type { HarnessFacts } from "../harness-facts.js";
import type { HarnessSpec } from "../harnesses.js";
import { type HostFolder, type HostState, NOT_ACCEPTED } from "../state.js";

// THE CONTRACT'S `providers` AND `accounts` GROUPS ON THIS COMPUTER. A provider here is a harness the reader has, or
// could have, on the side of the computer the folder is on; its one account is that harness's own stored sign-in, which
// this side neither holds nor reads. Connecting an account sets the harness up where it has to be fetched first, then
// runs the harness's own sign-in (sign-in.ts).

// The one account a signed-in harness has: its own.
const ACCOUNT_ID = `this-computer`;

// What the account of a harness that refused its last turn says: the sign-in is there and no longer works.
const EXPIRED = `Its sign-in on this computer no longer works. Sign in again to carry on.`;

// Named as the harness names it (a plan, "Claude Ultra"), else by the harness itself, which reads the same in every
// language: this side has no translations, and the window says whose sign-in it is in its own words.
const accountOf = (harness: HarnessSpec, known: HarnessFacts, connectedAt: number, expired: boolean): OauthAccount => {
    const account: OauthAccount = { id: ACCOUNT_ID, label: known.account?.label ?? harness.label, connectedAt };
    if (expired) {
        account.needsReauth = true;
        account.detail = EXPIRED;
    }
    if (known.account?.email !== undefined) {
        account.email = known.account.email;
    }
    if (known.account?.organization !== undefined) {
        account.organization = known.account.organization;
    }
    return account;
};

export const providersProcedures = (state: HostState, folder: HostFolder) =>
    ({
        list: async () => {
            const host = state.hostFor(folder.place);
            const states = await Promise.all(state.harnesses.map(async (harness) => ({ harness, standing: (await harnessState(host, harness)).state })));
            const ready = states.filter(({ standing }) => standing === `ready`).map(({ harness }) => harness);
            return {
                native: ready.flatMap((harness) => (harness.native ? [harness.id] : [])),
                agents: ready.flatMap((harness) => (harness.native ? [] : [{ id: harness.id, label: harness.label }])),
                endpoints: [],
                // Every harness this place runs or could be set up to run. One named here and not above is a press away:
                // connecting its account fetches it first.
                loops: Object.fromEntries(states.filter(({ standing }) => standing !== `missing`).map(({ harness }) => [harness.id, [`native`]])),
            };
        },
        models: async ({ provider }) => {
            const harness = state.harnessNamed(provider);
            const known = harness === undefined ? undefined : await state.factsFor(folder, harness);
            const first = known?.models[0];
            // A harness that names no models keeps its model to itself: one entry stands for "its own".
            return known === undefined || first === undefined
                ? { models: [{ id: `default`, label: `Default` }], default: `default` }
                : { models: [...known.models], default: known.defaultModel ?? first.id };
        },
    }) satisfies FixtureRouter[`providers`];

// The harness set up where it has to be fetched first; refuses with words a card shows when it cannot be.
const setUp = async (state: HostState, folder: HostFolder, harness: HarnessSpec) => {
    const host = state.hostFor(folder.place);
    if ((await harnessState(host, harness)).state === `fetchable`) {
        await fetchAdapter(host, harness, (line) => state.log(`[fetch ${harness.id}] ${line}`)).catch((error: Error) => refuse(errorMessage(error), 502));
    }
    const standing = await harnessState(host, harness);
    return standing.state === `ready` ? standing.launch : refuse(standing.state === `missing` ? standing.why : `${harness.label} could not be set up here.`, 409);
};

export const accountsProcedures = (state: HostState, folder: HostFolder) =>
    ({
        accounts: async ({ provider }) => {
            const harness = state.harnessNamed(provider);
            const known = harness === undefined ? undefined : await state.factsFor(folder, harness);
            if (harness === undefined || known === undefined || known.signedIn === `no`) {
                return { accounts: [] };
            }
            const expired = state.signInNeeded(state.keyOf(state.hostFor(folder.place), harness));
            return { accounts: [accountOf(harness, known, state.startedAt, expired)] };
        },
        start: async ({ provider }) => {
            if (!state.accepted()) {
                return refuse(NOT_ACCEPTED, 403);
            }
            const harness = state.harnessNamed(provider) ?? refuse(`This computer runs no harness for that provider.`, 404);
            const host = state.hostFor(folder.place);
            const key = state.keyOf(host, harness);
            const launch = await setUp(state, folder, harness);
            // Asked afresh: the reader may have signed in beside this, in a terminal, since it was last read.
            state.forgetFacts(key);
            // A harness that states an account and refused its last turn all the same is not signed in for any purpose
            // here: its own sign-in is run again.
            if (!state.signInNeeded(key) && (await state.factsFor(folder, harness))?.signedIn === `yes`) {
                return state.signIns.settled();
            }
            const cwd = state.cwdOf(folder);
            const connection = await state.connections.acquire(key, host, launch, cwd).catch((error: Error) => refuse(errorMessage(error), 502));
            return state.signIns.start(connection, host, cwd, harness.label, () => {
                // A running process may not see a sign-in made beside it: the next turn starts one that does.
                state.connections.drop(key);
                state.forgetFacts(key);
                state.noteSignIn(key, false);
            });
        },
        status: ({ handshake }) => state.signIns.status(handshake),
        cancel: ({ handshake }) => {
            state.signIns.cancel(handshake);
            return { ok: true as const };
        },
    }) satisfies FixtureRouter[`accounts`];
