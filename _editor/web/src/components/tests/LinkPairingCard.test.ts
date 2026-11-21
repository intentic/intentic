// The pairing as the Capabilities page draws it: inside the Linked sandbox card's own form. One press of Link pairs, and
// presses nothing else: a submit bubbles, so the card's Add used to fire with it, with nothing filled in yet (refused, its
// Advanced fold flung open in red), then once more when the pairing filled the form, which read as Add pressed twice.
import "@intentic/testing/dom";
import { IconStub } from "@intentic/ui/testing";
import PrimeVue from "primevue/config";
import { createApp, h, nextTick, ref } from "vue";
import * as actualPairing from "../linkPairing";
import type { PairedLink } from "../linkPairing";

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

it(`pairs on Link without submitting the card's form it is drawn inside`, async () => {
    const addPressed = jest.fn();
    const picked: PairedLink[] = [];
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
                [h(LinkPairing, { prefer: FAR.name, onPick: (paired: PairedLink) => picked.push(paired) })],
            ),
    });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    await settle();

    const link = [...el.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === `Link`);
    expect(link?.disabled).toBe(false);
    link?.click();
    await settle();

    expect([pairWith.mock.calls.length, picked, addPressed.mock.calls.length]).toEqual([1, [MINTED], 0]);
    app.unmount();
    el.remove();
});
