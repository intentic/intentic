// @vitest-environment jsdom
//
// WHAT THE WORKSPACE ASKS FOR, and the walk through it. Two claims are worth pinning here and neither is
// cosmetic: that a recommendation arrives with the thing that was READ to make it (a claim nobody can check is
// one nobody should act on), and that what the scan already knows is filled in — a wrong instance url is one of
// the two ways connecting a repository host fails silently, and the scan has already answered it.
import { expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import type { CapabilityRecommendation } from "@intentic-app/api-contract";

// The import-time globals a mounted view needs (see Capabilities.test.ts): ui's useDevice reads matchMedia at
// module scope, environment.ts reads window.env and throws without it.
vi.hoisted(() => {
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
    };
});

// Which card the page is on, and whether the setup walk is running — both read off the URL, so setting them
// before mount is the whole of arranging a case. `` is the catalog itself.
let card = ``;
let setup: string | undefined;
const push = vi.fn();
vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    useRoute: () => ({ params: { card }, query: setup === undefined ? {} : { setup } }) as never,
    useRouter: () => ({ push, replace: vi.fn() }) as never,
}));

// The gitlab card is CONTRIBUTED, not static — the connectors manifest narrowed to what a card needs. Its
// instance url is the field the scan can answer and the user should not have to.
vi.mock(`../composables/extensions/useExtensions`, () => ({
    useExtensions: () => ({
        contributionOf: () => undefined,
        extensions: ref([]),
        settled: ref(true),
        enabled: ref([
            {
                id: `intentic.connectors`,
                manifest: {
                    contributes: {
                        capabilities: [
                            {
                                id: `gitlab`,
                                kind: `cli`,
                                catalog: { name: `GitLab`, category: `code`, description: `Issues, merge requests and pipelines as agent tools.` },
                                fields: [
                                    { key: `url`, label: `Instance URL`, default: `https://gitlab.com` },
                                    { key: `token`, label: `Access token`, secret: true },
                                ],
                            },
                        ],
                    },
                },
            },
        ]),
    }),
}));

const recommendations = ref<CapabilityRecommendation[]>([]);
const dismiss = vi.fn();
vi.mock(`../composables/extensions/useCapabilities`, () => ({
    useCapabilities: () => ({
        hasCapability: () => true,
        recommendationFor: (id: string) => recommendations.value.find((recommendation) => recommendation.card === id),
        capabilities: ref([]),
        error: ref(undefined),
        add: vi.fn(),
        remove: { mutateAsync: vi.fn(), isPending: ref(false) },
        refetch: vi.fn(),
        dismissRecommendation: { mutateAsync: dismiss, isPending: ref(false) },
    }),
    browseMarketplace: vi.fn(),
}));
vi.mock(`../composables/terminal/useBackgroundProcesses`, () => ({
    useBackgroundProcesses: () => ({ rows: ref([]), busy: ref(undefined), start: vi.fn(), stop: vi.fn() }),
    viewProcessLogs: vi.fn(),
}));
vi.mock(`../composables/sandbox/useHostConnect`, () => ({
    useHostConnect: () => ({ hostFor: () => undefined, revoke: vi.fn(), refresh: vi.fn(), start: vi.fn(), stop: vi.fn() }),
}));
vi.mock(`../composables/sandbox/useVpn`, () => ({ importForticlient: vi.fn(), useVpn: () => ({ links: ref([]) }) }));
vi.mock(`../components/BrowserLoginDialog.vue`, () => ({ default: defineComponent({ render: () => null }) }));
vi.mock(`../components/HostConnectDialog.vue`, () => ({ default: defineComponent({ render: () => null }) }));

const { default: Capabilities } = await import("./Capabilities.vue");

const gitlab: CapabilityRecommendation = {
    card: `gitlab`,
    evidence: `api/.gitlab-ci.yml → git.acme.dev`,
    reason: `your repositories are hosted on your own GitLab`,
    prefill: { url: `https://git.acme.dev` },
};
const docker: CapabilityRecommendation = {
    card: `docker`,
    evidence: `api/docker-compose.yml`,
    reason: `your workspace has a compose stack to run`,
    prefill: {},
};

const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(Capabilities) });
    app.component(
        `Icon`,
        defineComponent({
            props: { name: String, spin: Boolean },
            render() {
                return h(`i`, { "data-icon": this.name });
            },
        }),
    );
    app.component(
        `RouterLink`,
        defineComponent({
            setup:
                (_, { slots }) =>
                () =>
                    h(`a`, slots["default"]?.()),
        }),
    );
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

const button = (el: HTMLElement, label: string): HTMLButtonElement =>
    [...el.querySelectorAll(`button`)].find((candidate) => candidate.textContent?.includes(label))!;

it(`offers the whole set as one thing to do, and says what each one was read off`, async () => {
    card = ``;
    setup = undefined;
    recommendations.value = [gitlab, docker];
    const el = mount();

    expect(el.textContent).toContain(`2 capabilities your workspace asks for`);
    // The claim and the artifact behind it, both on the tile — the second is what makes the first checkable.
    expect(el.textContent).toContain(`your repositories are hosted on your own GitLab`);
    expect(el.textContent).toContain(`api/.gitlab-ci.yml → git.acme.dev`);

    button(el, `Set them up`).click();
    await nextTick();
    // Into the first card WITH the walk running, so the form knows it is a step and not a lone visit.
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ params: { card: `gitlab` }, query: { setup: `recommended` } }));
});

it(`fills in what the scan could read, and leaves the credential to the user`, async () => {
    card = `gitlab`;
    setup = `recommended`;
    recommendations.value = [gitlab, docker];
    const el = mount();
    await nextTick();

    const inputs = [...el.querySelectorAll(`input`)];
    // The instance the scan identified, not the card's gitlab.com default — the whole point of pre-filling.
    expect(inputs.some((input) => input.value === `https://git.acme.dev`)).toBe(true);
    // The credential is the one thing this flow will not answer on the user's behalf.
    expect(inputs.filter((input) => input.type === `password`).every((input) => input.value === ``)).toBe(true);
    expect(el.textContent).toContain(`2 left`);
});

it(`takes "not needed" as an answer and moves on rather than asking again`, async () => {
    card = `gitlab`;
    setup = `recommended`;
    recommendations.value = [gitlab, docker];
    dismiss.mockResolvedValue(undefined);
    push.mockClear();
    const el = mount();
    await nextTick();

    button(el, `Not needed`).click();
    await vi.waitFor(() => expect(dismiss).toHaveBeenCalledWith(`gitlab`));
    // Straight on to the next in the queue, not back out to the grid the walk was started from.
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith(expect.objectContaining({ params: { card: `docker` } })));
});
