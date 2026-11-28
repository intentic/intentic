import { RAW_JSON_ROUTES, type RawJsonInput } from "@intentic/sandbox-contract/protocol/raw/raw-json-routes";
import { rawRouteUrl } from "@intentic/sandbox-contract/protocol/raw/raw-routes";
import { LINK_TURNS_PER_HOUR_DEFAULT, type LinkTerms } from "@intentic/sandbox-contract/schemas/links";
import type { S2sContact, S2sGrantsInput, S2sMe, S2sPairingAnswer, SandboxIdentity } from "@intentic/sandbox-contract/schemas/s2s";
import { hasInjectionContext, inject, type InjectionKey } from "vue";
import { sandboxJsonAt } from "../client/sandbox/sandboxClient";
import { SandboxHttpError } from "../client/sandbox/sandboxHttpError";
import { sandboxRaw } from "../client/sandbox/sandboxRaw";

// PAIRING TWO OF THE READER'S SANDBOXES AS CONTACTS (docs/architecture/messages.md, "Two ways to make one"), done by this
// editor because it is the one party signed in to both. It reads this sandbox's document here, posts it to the other
// sandbox under the reader's session there (POST /s2s/pairings), which files an accepted contact and answers its own
// document and grants, and hands that answer back here (POST /s2s/contacts/paired). No message crosses: each side pins
// the other's key from a document read over the reader's own sessions. Here among the components rather than with the
// Messages tab, since the link pairing (LinkPairing.vue) and the route card pair contacts too (2026-11-27).

/** The four daemon calls a pairing makes, here and on the other sandbox; the Messages tab's seam carries the same ones. */
export interface ContactPairingApi {
    readonly me: () => Promise<S2sMe>;
    /** The public document alone (GET /s2s/identity), which needs no floor: what a reader below maintainer pairs with. */
    readonly identity: () => Promise<SandboxIdentity>;
    /** POST /s2s/pairings on another of the reader's sandboxes, under their session there. */
    readonly pairAt: (sandboxId: string, request: RawJsonInput<`POST /s2s/pairings`>) => Promise<S2sPairingAnswer>;
    readonly paired: (paired: RawJsonInput<`POST /s2s/contacts/paired`>) => Promise<S2sContact>;
}

/** The daemon's own: this sandbox through `sandboxRaw`, the other one's half under the reader's session there. */
export const daemonContactPairingApi: ContactPairingApi = {
    me: () => sandboxRaw(`GET /s2s/me`),
    identity: () => sandboxRaw(`GET /s2s/identity`),
    pairAt: (sandboxId, request) =>
        sandboxJsonAt(sandboxId, rawRouteUrl(`POST /s2s/pairings`), RAW_JSON_ROUTES[`POST /s2s/pairings`].output, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify(request),
        }),
    paired: (paired) => sandboxRaw(`POST /s2s/contacts/paired`, { input: paired }),
};

export const CONTACT_PAIRING_API: InjectionKey<ContactPairingApi> = Symbol.for(`intentic.contact-pairing-api`);

/** The seam an ancestor provided, or the daemon's own; outside a setup (a plain handler) always the daemon's. */
export const useContactPairingApi = (): ContactPairingApi => (hasInjectionContext() ? inject(CONTACT_PAIRING_API, daemonContactPairingApi) : daemonContactPairingApi);

export interface PairContactAsk {
    /** The other sandbox, by its id and name. */
    readonly far: { readonly id: string; readonly name: string };
    /** The sandbox as itself (a maintainer's press on both sides), or the reader's own route between the two. */
    readonly scope: `sandbox` | `person`;
    /** What this sandbox lets the other do here. */
    readonly here: S2sGrantsInput;
    /** What the other sandbox lets this one do there. */
    readonly there: S2sGrantsInput;
}

export interface PairContactWords {
    /** Said when the other sandbox's build has no pairing door. */
    readonly tooOld: string;
}

/** A pairing refused only because one of the two daemons has no contacts yet (its 404): the older pairing still works. */
export class ContactsUnsupported extends Error {}

// A daemon's 404 for a contact route, as the build that lacks it; anything else is passed on in its own words.
const unsupportedIf404 = async <T>(call: () => Promise<T>, words: string): Promise<T> => {
    try {
        return await call();
    } catch (error) {
        throw error instanceof SandboxHttpError && error.status === 404 ? new ContactsUnsupported(words, { cause: error }) : error;
    }
};

/**
 * This sandbox's document: GET /s2s/me for a maintainer, who reads the whole identity anyway, and the public document
 * (GET /s2s/identity) for anyone below, whom /s2s/me refuses while pairing their own route is theirs.
 */
const ownDocument = async (api: Pick<ContactPairingApi, `me` | `identity`>, maintainer: boolean): Promise<SandboxIdentity> =>
    maintainer ? (await api.me()).document : api.identity();

/**
 * Pairs the two, and answers the contact filed here. A daemon from before contacts (the other, or this one when it is
 * older than this editor) answers 404, thrown as ContactsUnsupported in the words given.
 */
export const pairContact = async (
    api: ContactPairingApi,
    ask: PairContactAsk,
    maintainer: boolean,
    words: PairContactWords,
): Promise<S2sContact> => {
    const document = await unsupportedIf404(() => ownDocument(api, maintainer), words.tooOld);
    const answer = await unsupportedIf404(() => api.pairAt(ask.far.id, { document, scope: ask.scope, grants: ask.there, theirGrants: ask.here }), words.tooOld);
    return api.paired({ answer, scope: ask.scope, grants: ask.here });
};

/* THE SENDING PREFERENCE (docs/architecture/messages.md, "Across versions"): nothing new is minted as a link token or a
 * route pairing toward a sandbox that speaks s2s/1. The link pairing (components/linkPairing.ts) and the route card
 * (features/needs/routing/NeedRouteBody.vue) make a contact there instead, with the grants the old credential would have
 * carried (the daemon's own upgrade of an existing one files the same, links/upgrade/ and pairing-upgrade.ts), and keep
 * the old way for a daemon from before contacts. */

export type Preferred<Old> = { readonly kind: `contact`; readonly contact: S2sContact } | { readonly kind: `old`; readonly value: Old };

/**
 * A contact where this daemon serves contact pairing and the other answers it, else the old pairing. Only a daemon's
 * missing route falls back; a refusal in words (a blocked contact, a tier too low) is passed on, never covered over.
 */
export const pairPreferringContact = async <Old>(hereServesContacts: boolean, contact: () => Promise<S2sContact>, old: () => Promise<Old>): Promise<Preferred<Old>> => {
    if (hereServesContacts) {
        try {
            return { kind: `contact`, contact: await contact() };
        } catch (error) {
            if (!(error instanceof ContactsUnsupported)) {
                throw error;
            }
        }
    }
    return { kind: `old`, value: await old() };
};

/** What the sandbox holding a link lets the other do: say things back, and wake it, so a task's report wakes it. */
export const LINK_ASKER_GRANTS: S2sGrantsInput = { message: true, wake: true };

/** What a link's terms let the asking sandbox do over there, as a contact's grants under the same names. */
export const linkContactGrants = (terms: LinkTerms): S2sGrantsInput => {
    const grants: S2sGrantsInput = { message: true, records: terms.records, operate: terms.operate, wake: true };
    if (terms.tasks) {
        const task: NonNullable<S2sGrantsInput[`task`]> = { approve: terms.approve, turnsPerHour: terms.turnsPerHour };
        if (terms.actsAs !== undefined) {
            task.actsAs = terms.actsAs;
        }
        if (terms.runAs !== undefined) {
            task.runAs = terms.runAs;
        }
        grants.task = task;
    }
    return grants;
};

/** What a person's route let this sandbox do as them over there: their drops, reads and tasks, held to their floor there. */
export const PERSON_ROUTE_GRANTS: S2sGrantsInput = { message: true, task: { approve: false, turnsPerHour: LINK_TURNS_PER_HOUR_DEFAULT }, records: true, wake: true };

/** What this sandbox lets the other do over the person's contact: say things back, and wake it. */
export const ROUTE_ASKER_GRANTS: S2sGrantsInput = { message: true, wake: true };
