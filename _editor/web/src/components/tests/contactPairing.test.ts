import type { S2sContact, SandboxIdentity } from "@intentic/sandbox-contract/schemas/s2s";
import { S2sGrantsSchema } from "@intentic/sandbox-contract/schemas/s2s";
import { unstubbed } from "@intentic/testing";
import { SandboxHttpError } from "../../client/sandbox/sandboxHttpError";
import {
    ContactsUnsupported,
    LINK_ASKER_GRANTS,
    linkContactGrants,
    pairContact,
    pairPreferringContact,
    PERSON_ROUTE_GRANTS,
    ROUTE_ASKER_GRANTS,
} from "../contactPairing";
import type { MessagesApi, S2sPairedInput, S2sPairingRequestInput } from "../../models/messages/messagesApi";

// Pairing two of the reader's sandboxes as contacts: this sandbox's document read here, posted there under the reader's
// session, and the far answer handed back here, with each side's grants going to the side that enforces them.

const FP_HERE = `isk1:${`a`.repeat(52)}`;
const FP_THERE = `isk1:${`b`.repeat(52)}`;
const sig = { ed25519: `s`, mldsa65: `s` };
const keys = { ed25519: `k`, mldsa65: `k`, x25519: `k`, mlkem768: `k` };
const documentOf = (sandbox: string, fingerprint: string): SandboxIdentity => ({
    v: 1,
    sandbox,
    name: sandbox,
    host: `${sandbox}.intentic.app`,
    domains: [],
    keys,
    fingerprint,
    protocols: [`s2s/1`],
    issuedAt: 1,
    sig,
});
const HERE = documentOf(`here`, FP_HERE);
const THERE = documentOf(`there`, FP_THERE);

const filed = (answer: S2sPairedInput): S2sContact => ({
    id: `c-there`,
    address: answer.answer.document.host,
    name: answer.answer.document.name,
    host: answer.answer.document.host,
    domains: [],
    fingerprint: answer.answer.document.fingerprint,
    scope: answer.scope === `person` ? { kind: `person`, person: `ada@acme.dev` } : { kind: `sandbox` },
    state: `accepted`,
    grants: S2sGrantsSchema.parse(answer.grants),
    holdsWake: answer.answer.wake !== undefined,
    notices: [],
    origin: `paired`,
    createdAt: 1,
    updatedAt: 1,
});

// What the fake was handed: where the far half went, what it carried, and what came back here.
interface Posted {
    at?: string;
    request?: S2sPairingRequestInput;
    paired?: S2sPairedInput;
}

// The one fake: records each call in order, and answers as both daemons would; `refuse` throws what the far daemon says.
const fakeApi = (refuse?: () => Promise<void>) => {
    const calls: string[] = [];
    const posted: Posted = {};
    const api = unstubbed<MessagesApi>(`messages`, {
        me: async () => {
            calls.push(`me`);
            return { document: HERE, domains: [], recovery: false, previousKeys: 0 };
        },
        identity: async () => {
            calls.push(`identity`);
            return HERE;
        },
        pairAt: async (sandboxId, request) => {
            calls.push(`pairAt`);
            posted.at = sandboxId;
            posted.request = request;
            await refuse?.();
            return { contact: `c-here`, document: THERE, grants: S2sGrantsSchema.parse(request.grants), wake: `w`.repeat(40) };
        },
        paired: async (paired) => {
            calls.push(`paired`);
            posted.paired = paired;
            return filed(paired);
        },
    });
    return { api, calls, posted };
};

const WORDS = { tooOld: `there runs a build too old to pair` };

it(`posts this sandbox's document there and hands the far answer back here`, async () => {
    const { api, calls, posted } = fakeApi();
    const contact = await pairContact(
        api,
        { far: { id: `sbx-there`, name: `there` }, scope: `sandbox`, here: { message: true, report: true }, there: { message: true, wake: true } },
        true,
        WORDS,
    );
    expect(calls).toEqual([`me`, `pairAt`, `paired`]);
    expect(posted.at).toBe(`sbx-there`);
    // There, `grants` is what THAT sandbox lets this one do; what this one lets it do rides along as `theirGrants`.
    expect(posted.request).toEqual({ document: HERE, scope: `sandbox`, grants: { message: true, wake: true }, theirGrants: { message: true, report: true } });
    expect(posted.paired?.answer.document.fingerprint).toBe(FP_THERE);
    expect(posted.paired?.grants).toEqual({ message: true, report: true });
    expect([contact.fingerprint, contact.state, contact.holdsWake]).toEqual([FP_THERE, `accepted`, true]);
});

it(`reads the public document for a reader below maintainer, whom /s2s/me refuses`, async () => {
    const { api, calls, posted } = fakeApi();
    await pairContact(api, { far: { id: `sbx-there`, name: `there` }, scope: `person`, here: {}, there: {} }, false, WORDS);
    expect(calls).toEqual([`identity`, `pairAt`, `paired`]);
    expect(posted.request?.scope).toBe(`person`);
});

it(`says a far daemon from before contacts is too old, and files nothing here`, async () => {
    const { api, calls } = fakeApi(async () => {
        throw new SandboxHttpError(404, `not found`);
    });
    const pairing = pairContact(api, { far: { id: `sbx-there`, name: `there` }, scope: `sandbox`, here: {}, there: {} }, true, WORDS);
    await expect(pairing).rejects.toThrow(ContactsUnsupported);
    await expect(pairing).rejects.toThrow(WORDS.tooOld);
    expect(calls).toEqual([`me`, `pairAt`]);
});

it(`passes any other refusal there on in its own words`, async () => {
    const { api } = fakeApi(async () => {
        throw new SandboxHttpError(403, `Only a maintainer pairs this sandbox as itself.`);
    });
    await expect(pairContact(api, { far: { id: `sbx-there`, name: `there` }, scope: `sandbox`, here: {}, there: {} }, true, WORDS)).rejects.toThrow(
        `Only a maintainer pairs this sandbox as itself.`,
    );
});

// THE SENDING PREFERENCE: the link pairing and the route card make a contact where both daemons serve contact pairing,
// and keep the old pairing for a daemon from before contacts. `old` stands in for minting a link or a route pairing.
describe(`pairPreferringContact`, () => {
    const preferring = (hereServes: boolean, refuse?: () => Promise<void>) => {
        const { api, calls } = fakeApi(refuse);
        const old = jest.fn(async () => `minted the old way`);
        const pairing = pairPreferringContact(
            hereServes,
            () => pairContact(api, { far: { id: `sbx-there`, name: `there` }, scope: `sandbox`, here: LINK_ASKER_GRANTS, there: { message: true } }, true, WORDS),
            old,
        );
        return { pairing, calls, old };
    };

    it(`makes a contact, and mints nothing, where both daemons serve it`, async () => {
        const { pairing, calls, old } = preferring(true);
        const made = await pairing;
        expect([made.kind, made.kind === `contact` ? made.contact.fingerprint : undefined]).toEqual([`contact`, FP_THERE]);
        expect(calls).toEqual([`me`, `pairAt`, `paired`]);
        expect(old).not.toHaveBeenCalled();
    });

    it(`goes the old way for a far daemon from before contacts`, async () => {
        const { pairing, calls, old } = preferring(true, async () => {
            throw new SandboxHttpError(404, `not found`);
        });
        expect(await pairing).toEqual({ kind: `old`, value: `minted the old way` });
        expect(calls).toEqual([`me`, `pairAt`]);
    });

    it(`goes the old way, asking nothing of contacts, when this daemon does not serve them`, async () => {
        const { pairing, calls, old } = preferring(false);
        expect(await pairing).toEqual({ kind: `old`, value: `minted the old way` });
        expect([calls, old.mock.calls.length]).toEqual([[], 1]);
    });

    it(`passes a refusal in words on, and mints nothing over it`, async () => {
        const { pairing, old } = preferring(true, async () => {
            throw new SandboxHttpError(409, `there.intentic.app is blocked here: remove the block first`);
        });
        await expect(pairing).rejects.toThrow(`there.intentic.app is blocked here: remove the block first`);
        expect(old).not.toHaveBeenCalled();
    });
});

describe(`the grants an old credential carries`, () => {
    it(`gives a link's terms to the contact under their own names, tasks only while the link takes them`, () => {
        const terms = { actsAs: `ops`, approve: false, turnsPerHour: 7, tasks: true, records: true, operate: true };
        expect(linkContactGrants(terms)).toEqual({ message: true, records: true, operate: true, wake: true, task: { actsAs: `ops`, approve: false, turnsPerHour: 7 } });
        expect(linkContactGrants({ ...terms, tasks: false, operate: false })).toEqual({ message: true, records: true, operate: false, wake: true });
    });

    it(`gives a person's route their drops, reads and tasks over there, and nothing but messages and wakes back`, () => {
        expect([PERSON_ROUTE_GRANTS, ROUTE_ASKER_GRANTS]).toEqual([
            { message: true, task: { approve: false, turnsPerHour: 20 }, records: true, wake: true },
            { message: true, wake: true },
        ]);
    });
});
