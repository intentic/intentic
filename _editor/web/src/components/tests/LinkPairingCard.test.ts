// The pairing as the Capabilities page draws it: inside the Linked sandbox card's own form. One press of Link pairs, and
// presses nothing else: a submit bubbles, so the card's Add used to fire with it, with nothing filled in yet (refused, its
// Advanced fold flung open in red), then once more when the pairing filled the form, which read as Add pressed twice.
// Where both sandboxes speak s2s/1 the press makes a contact instead (no link is minted toward such a sandbox), with the
// terms as its grants; a daemon from before contacts (its 404) is linked as before.
import "@intentic/testing/dom";
import type { S2sContact, SandboxIdentity } from "@intentic/sandbox-contract/schemas/s2s";
import { S2sGrantsSchema } from "@intentic/sandbox-contract/schemas/s2s";
import { unstubbed } from "@intentic/testing";
import { IconStub } from "@intentic/ui/testing";
import PrimeVue from "primevue/config";
import { createApp, h, nextTick, ref } from "vue";
import * as actualPairing from "../linkPairing";
import type { PairedLink } from "../linkPairing";
import { CONTACT_PAIRING_API, type ContactPairingApi } from "../contactPairing";
import { SandboxHttpError } from "../../client/sandbox/sandboxHttpError";

// The platform's row for each, as much of it as the picker reads.
const row = { tier: `owner`, hosted: null, hostReport: null, sleep: null, lastSeenAt: null };
const FAR = { ...row, id: `7e8d0ffa8bed`, name: `Ops box`, daemonUrl: `https://sandbox-7e8d0ffa8bed.radarsu.com` };
const MINTED: PairedLink = { id: `ops-box`, url: FAR.daemonUrl, token: `ilk_minted`, name: FAR.name, sandboxId: FAR.id };

jest.mock(`../../client/sandbox/useSandbox`, () => ({
    useSandbox: () => ({
        sandboxes: ref([FAR, { ...row, id: `here`, name: `here`, daemonUrl: `https://sandbox-here.radarsu.com` }]),
        active: ref({ name: `here` }),
        activeSandboxId: ref(`here`),
        daemonUrl: ref(`https://sandbox-here.radarsu.com`),
    }),
}));
// Snapshotted before the mock replaces the module: a namespace is a live binding.
const realPairing = { ...actualPairing };
const pairWith = jest.fn(async (): Promise<PairedLink> => MINTED);
jest.mock(`../linkPairing`, () => ({ ...realPairing, rolesAt: async () => [], pairWith }));

const { default: LinkPairing } = await import("../LinkPairing.vue");

const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 4; turn += 1) {
        await nextTick();
        await Promise.resolve();
    }
};

const FINGERPRINT = `isk1:${`b`.repeat(52)}`;
const documentOf = (sandbox: string): SandboxIdentity => ({
    v: 1,
    sandbox,
    name: sandbox,
    host: `${sandbox}.intentic.app`,
    domains: [],
    keys: { ed25519: `k`, mldsa65: `k`, x25519: `k`, mlkem768: `k` },
    fingerprint: FINGERPRINT,
    protocols: [`s2s/1`],
    issuedAt: 1,
    sig: { ed25519: `s`, mldsa65: `s` },
});
const CONTACT: S2sContact = {
    id: `c-ops`,
    address: `ops.intentic.app`,
    name: FAR.name,
    host: `ops.intentic.app`,
    domains: [],
    fingerprint: FINGERPRINT,
    scope: { kind: `sandbox` },
    state: `accepted`,
    grants: S2sGrantsSchema.parse({ message: true, wake: true }),
    holdsWake: true,
    notices: [],
    origin: `paired`,
    createdAt: 1,
    updatedAt: 1,
};

// The one fake of the pairing's daemon calls: `far404` is a far daemon from before contacts. What went where is recorded.
const contactsFake = (far404: boolean) => {
    const posted: { at?: string; grants?: unknown }[] = [];
    const api = unstubbed<ContactPairingApi>(`contact-pairing`, {
        me: async () => ({ document: documentOf(`here`), domains: [], recovery: false, previousKeys: 0 }),
        pairAt: async (sandboxId, request) => {
            posted.push({ at: sandboxId, grants: request.grants });
            if (far404) {
                throw new SandboxHttpError(404, `not found`);
            }
            return { contact: `c-here`, document: documentOf(`ops`), grants: S2sGrantsSchema.parse(request.grants) };
        },
        paired: async () => CONTACT,
    });
    return { api, posted };
};

// LinkPairing drawn inside a form whose Add must not fire, with the fake's calls behind it.
const mounted = async (api: ContactPairingApi) => {
    const addPressed = jest.fn();
    const picked: PairedLink[] = [];
    const contacted: S2sContact[] = [];
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({
        render: () =>
            h(
                `form`,
                {
                    onSubmit: (event: Event) => {
                        event.preventDefault();
                        addPressed();
                    },
                },
                [h(LinkPairing, { prefer: FAR.name, onPick: (paired: PairedLink) => picked.push(paired), onContact: (made: S2sContact) => contacted.push(made) })],
            ),
    });
    app.use(PrimeVue);
    app.provide(CONTACT_PAIRING_API, api);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    await settle();
    const link = [...el.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === `Link`);
    expect(link?.disabled).toBe(false);
    link?.click();
    await settle();
    return {
        addPressed,
        picked,
        contacted,
        el,
        done: () => {
            app.unmount();
            el.remove();
        },
    };
};

beforeEach(() => {
    pairWith.mockClear();
});

it(`links a far daemon from before contacts on Link, without submitting the card's form it is drawn inside`, async () => {
    const { api, posted } = contactsFake(true);
    const { addPressed, picked, contacted, done } = await mounted(api);
    expect([pairWith.mock.calls.length, picked, contacted, addPressed.mock.calls.length]).toEqual([1, [MINTED], [], 0]);
    // The contact was asked for first, and its 404 is all that sent the press the old way.
    expect(posted.map((one) => one.at)).toEqual([FAR.id]);
    done();
});

it(`makes a contact holding the link's terms where both speak s2s/1, and mints no link`, async () => {
    const { api, posted } = contactsFake(false);
    const { addPressed, picked, contacted, el, done } = await mounted(api);
    expect([pairWith.mock.calls.length, picked, contacted, addPressed.mock.calls.length]).toEqual([0, [], [CONTACT], 0]);
    // There, the grants are what that sandbox lets this one do: the default task terms, no records, no operating.
    expect(posted).toEqual([{ at: FAR.id, grants: { message: true, records: false, operate: false, wake: true, task: { approve: true, turnsPerHour: 20 } } }]);
    expect(el.querySelector(`[data-paired-contact]`)?.textContent).toContain(FAR.name);
    done();
});
