// A capability need's card picks its answer by the kind's slots (kinds/kindSlots.ts): a linked sandbox is paired in the
// card, on the sandbox the agent named, and the fleet allowed in one press, each beside the way to the full form; a kind
// whose form alone finishes the setup carries that form; anything that pairs a device goes to its own page instead.
// The mint's own notice stays under a link's pairing, while under the fleet's Allow it gives way to the need's own.
import "@intentic/testing/dom";
import type { CapabilityNeed, Need } from "@intentic/sandbox-contract/schemas/needs";
import { IconStub } from "@intentic/ui/testing";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import PrimeVue from "primevue/config";
import { createApp, defineComponent, h, nextTick, ref } from "vue";

const needNotice = ref<{ tone: string; title: string } | undefined>(undefined);
jest.mock(`../../models/needs/useNeeds`, () => ({ useNeeds: () => ({ answer: { mutateAsync: jest.fn() } }) }));
jest.mock(`./needAnswer`, () => ({
    useNeedAnswer: () => ({ busy: ref(false), notice: needNotice, lines: ref([]), answer: jest.fn(async () => ({ state: `done` })) }),
}));
jest.mock(`../../models/capabilities/useCapabilities`, () => ({ useCapabilities: () => ({ capabilities: ref([]), add: jest.fn(), remove: jest.fn() }) }));
// The form's key and secret fields read the daemon's secrets; here only whether the form is drawn matters.
const field = { default: defineComponent({ setup: () => () => h(`span`) }) };
jest.mock(`../../parts/capabilities/SshKeyField.vue`, () => field);
jest.mock(`../../parts/capabilities/SecretField.vue`, () => field);
jest.mock(`../../models/extensions/useExtensions`, () => ({ useExtensions: () => ({ enabled: ref([]) }) }));
jest.mock(`../../components/ChatDecisionButton.vue`, () => ({
    default: defineComponent({ setup: (_props, { slots }) => () => h(`button`, { type: `button` }, slots[`default`]?.()) }),
}));
// The one-press parts have their own suites; here each says what it was drawn with and raises its notice on a press.
const part = (name: string) =>
    defineComponent({
        name,
        props: { prefer: { type: String, default: undefined }, save: { type: Function, default: undefined } },
        emits: [`notice`, `pick`],
        setup:
            (props, { emit }) =>
            () =>
                h(`div`, { "data-part": name, "data-prefer": props.prefer ?? ``, "data-saves": String(props.save !== undefined) }, [
                    h(`button`, { "data-raise": name, onClick: () => emit(`notice`, { tone: `danger`, title: `${name} refused` }) }),
                ]),
    });
jest.mock(`../../components/LinkPairing.vue`, () => ({ default: part(`LinkPairing`) }));
jest.mock(`../capabilities/connect/FleetAllow.vue`, () => ({ default: part(`FleetAllow`) }));

const { default: NeedCapabilityBody } = await import("./NeedCapabilityBody.vue");

const mount = (subject: CapabilityNeed): HTMLElement => {
    const need: Need = { id: `need-1`, conversationId: `c-1`, title: subject.name, subject, status: `open`, createdAt: 1, updatedAt: 1 };
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(NeedCapabilityBody, { need, subject }) });
    app.use(PrimeVue);
    app.use(VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { enabled: false } } }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};
const connect = (entry: string, extra: Partial<CapabilityNeed> = {}): CapabilityNeed => ({ kind: `capability`, entry, name: entry, mode: `connect`, ...extra });
const raise = async (el: HTMLElement, name: string): Promise<void> => {
    el.querySelector<HTMLButtonElement>(`[data-raise="${name}"]`)?.click();
    await nextTick();
};

beforeEach(() => {
    needNotice.value = undefined;
    document.body.innerHTML = ``;
});

it(`pairs a linked sandbox in the card, on the one the agent named, and keeps the mint's notice under it`, async () => {
    const el = mount(connect(`link`, { target: `ops-box` }));

    expect(el.querySelector(`[data-part="LinkPairing"]`)?.getAttribute(`data-prefer`)).toBe(`ops-box`);
    expect(el.querySelector(`[data-part="FleetAllow"]`)).toBeNull();
    expect(el.querySelector(`form`)).toBeNull();
    expect(el.textContent).toContain(`Full form`);

    needNotice.value = { tone: `danger`, title: `the need's own` };
    await raise(el, `LinkPairing`);
    expect(el.textContent).toContain(`LinkPairing refused`);
});

it(`allows the fleet in one press, its mint's notice giving way to the need's own`, async () => {
    const el = mount(connect(`fleet`));

    expect(el.querySelector(`[data-part="FleetAllow"]`)?.getAttribute(`data-saves`)).toBe(`true`);
    expect(el.querySelector(`[data-part="LinkPairing"]`)).toBeNull();
    expect(el.querySelector(`form`)).toBeNull();

    await raise(el, `FleetAllow`);
    expect(el.textContent).toContain(`FleetAllow refused`);
    needNotice.value = { tone: `danger`, title: `the need's own` };
    await nextTick();
    expect(el.textContent).not.toContain(`FleetAllow refused`);
});

it(`carries the form for a kind it alone finishes, and sends one that dials a tunnel to its own page`, () => {
    const ssh = mount(connect(`ssh`));
    expect(ssh.querySelector(`form`)).not.toBeNull();
    expect(ssh.querySelector(`[data-part]`)).toBeNull();

    const vpn = mount(connect(`vpn`));
    expect(vpn.textContent).toContain(`set up on its own page`);
    expect(vpn.querySelector(`form`)).toBeNull();
    expect(vpn.querySelector(`[data-part]`)).toBeNull();
});

it(`draws no one-press part outside a connect`, () => {
    const el = mount({ kind: `capability`, entry: `link`, name: `link`, mode: `remove`, instance: `ops-box` });
    expect(el.querySelector(`[data-part]`)).toBeNull();
});
