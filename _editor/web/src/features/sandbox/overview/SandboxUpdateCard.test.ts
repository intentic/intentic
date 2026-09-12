// @vitest-environment jsdom
// The card that offers the registry's update, and the one shape where that offer is wrong: a sandbox whose base was
// compiled from a checkout. Pulling there REPLACES what the checkout built instead of refreshing it, so the offer is
// the rebuild from that checkout, and the trade is spelled out rather than made by a click.
import type { Environment } from "@intentic/sandbox-contract";
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

const updateAvailable = ref(true);
const localImage = ref<Environment[`localImage`]>(undefined);
vi.mock(`./useSandboxVersion`, () => ({
    useSandboxVersion: () => ({
        info: ref({ version: `1.53.0`, channel: `stable` }),
        installed: ref(`1.53.0`),
        latest: ref(`1.54.0`),
        updateAvailable,
        updateNotes: ref([]),
        moreUpdateNotes: ref(0),
        breakingNotes: ref([]),
        updateStaged: ref(false),
        stagedBehind: ref(undefined),
        serverManaged: ref(false),
        slug: ref(`demo`),
        localImage,
    }),
}));
vi.mock(`../../agents/fleet/useAgents`, () => ({ useAgents: () => ({ fleet: ref([]) }) }));
vi.mock(`../client/useSandbox`, () => ({ useSandbox: () => ({ active: ref({ id: `sb1`, role: `owner` }) }) }));
vi.mock(`../../../lib/useApi`, () => ({ apiClient: { sandbox: { hostedRestart: async () => undefined } } }));
// Marked, not mounted: which executor the card chose is the whole subject, and each reaches a device on its own.
vi.mock(`../../capabilities/connect/HostRecreate.vue`, () => ({
    default: defineComponent({
        props: { action: { type: String, default: `` } },
        render(): ReturnType<typeof h> {
            return h(`div`, { "data-recreate": this.action });
        },
    }),
}));
vi.mock(`../environment/DevRebuild.vue`, () => ({ default: defineComponent({ render: () => h(`div`, { "data-executor": `checkout` }) }) }));

const { default: SandboxUpdateCard } = await import("./SandboxUpdateCard.vue");

let app: App | undefined;
const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxUpdateCard) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

afterEach(() => {
    updateAvailable.value = true;
    localImage.value = undefined;
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`offers the published update on a sandbox that follows the registry`, () => {
    const el = mount();
    expect([...el.querySelectorAll(`[data-recreate]`)].map((node) => node.getAttribute(`data-recreate`))).toEqual([`Download`, `Update`]);
    expect(el.querySelector(`[data-executor="checkout"]`)).toBeNull();
});

it(`offers the checkout's rebuild instead of the pull on a sandbox built from one`, () => {
    localImage.value = { base: `intentic-sandbox:dev`, root: `/home/ada/intentic` };
    const el = mount();
    expect(el.querySelector(`[data-executor="checkout"]`)).not.toBeNull();
    // The two buttons that would have traded the checkout's image for a published one, gone rather than restyled.
    expect(el.querySelectorAll(`[data-recreate]`)).toHaveLength(0);
    expect(el.textContent).toContain(`Built from your checkout`);
    // The way out is still stated, as a command someone has to mean: the published build is named, so is the cost.
    expect(el.textContent).toContain(`discards the image built from your checkout`);
    expect(el.textContent).toContain(`ic sandbox update demo --force`);
});
