// Pins that a recommendation carries the evidence read to make it, and that scan-known answers (e.g. an instance
// url) are pre-filled. The evidence is legible on the entry, not the entry, since the grid stays one-line entrys.
import "@intentic/testing/dom";
import { waitFor } from "@intentic/testing/bun";
import { createApp, defineComponent, h, nextTick, ref } from "vue";
import type { CapabilityRecommendation } from "@intentic/api-contract";
import { IconStub } from "@intentic/ui/testing";
import * as actualVueRouter from "vue-router";

// Import-time globals a mounted view needs: ui's useDevice reads matchMedia, environment.ts reads window.env.

// Which entry the page is on and whether the setup walk runs, both read off the URL; `` is the catalog itself.
let entry = ``;
let setup: string | undefined;
const push = jest.fn();
jest.mock(`vue-router`, () => ({
    ...actualVueRouter,
    useRoute: () => ({ params: { entry }, query: setup === undefined ? {} : { setup } }) as never,
    useRouter: () => ({ push, replace: jest.fn() }) as never,
}));

// The gitlab entry is contributed, not static, with its instance url as the field the scan can answer. The registry
// cache backs the Extension entry's counts; nothing here has browsed it.
jest.mock(`../extensions/useRegistry`, () => ({ useRegistry: () => ({ entries: ref([]) }) }));
jest.mock(`../extensions/useExtensions`, () => ({
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
const dismiss = jest.fn();
jest.mock(`./connect/useCapabilities`, () => ({
    useCapabilities: () => ({
        recommendationFor: (id: string) => recommendations.value.find((recommendation) => recommendation.entry === id),
        capabilities: ref([]),
        error: ref(undefined),
        add: jest.fn(),
        remove: { mutateAsync: jest.fn(), isPending: ref(false) },
        rename: { mutateAsync: jest.fn(), isPending: ref(false) },
        refetch: jest.fn(),
        dismissRecommendation: { mutateAsync: dismiss, isPending: ref(false) },
    }),
    browseMarketplace: jest.fn(),
    // The connect forms read these at link time though no case here opens one; a mock missing a name anything in
    // the graph imports is refused.
    readRemoteRefs: jest.fn(async () => ({ refs: [] })),
    probeCapability: jest.fn(),
}));
jest.mock(`../terminal/useBackgroundProcesses`, () => ({
    useBackgroundProcesses: () => ({ rows: ref([]), busy: ref(undefined), start: jest.fn(), stop: jest.fn() }),
    viewProcessLogs: jest.fn(),
}));
jest.mock(`../composables/sandbox/useHostConnect`, () => ({
    useHostConnect: () => ({ hostFor: () => undefined, revoke: jest.fn(), refresh: jest.fn(), start: jest.fn(), stop: jest.fn() }),
}));
// LiveLinkRows opens as well as lists, so `error` must be present or the render throws.
jest.mock(`../sandbox/devices/useLiveLinks`, () => ({
    importForticlient: jest.fn(),
    useLiveLinks: () => ({ links: ref([]), error: ref(undefined), open: jest.fn(), close: jest.fn() }),
}));
jest.mock(`./connect/BrowserProfileDialog.vue`, () => ({ default: defineComponent({ render: () => null }) }));
jest.mock(`./connect/HostConnectDialog.vue`, () => ({ default: defineComponent({ render: () => null }) }));

const { default: Capabilities } = await import("./Capabilities.vue");

const gitlab: CapabilityRecommendation = {
    entry: `gitlab`,
    evidence: `api/.gitlab-ci.yml → git.acme.dev`,
    reason: `your repositories are hosted on your own GitLab`,
    prefill: { url: `https://git.acme.dev` },
};
const docker: CapabilityRecommendation = {
    entry: `docker`,
    evidence: `api/docker-compose.yml`,
    reason: `your workspace has a compose stack to run`,
    prefill: {},
};

const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(Capabilities) });
    app.component(`Icon`, IconStub);
    app.component(
        `RouterLink`,
        defineComponent({
            setup:
                (_, { slots }) =>
                () =>
                    h(`a`, slots["default"]?.()),
        }),
    );
    // Real tooltip directive shows a popover on hover; this stub parks the text on the element so tests can read it
    // without a pointer.
    app.directive(`tooltip`, { mounted: (node: HTMLElement, binding) => (node.dataset[`tooltip`] = String(binding.value)) });
    app.mount(el);
    return el;
};

const button = (el: HTMLElement, label: string): HTMLButtonElement =>
    [...el.querySelectorAll(`button`)].find((candidate) => candidate.textContent?.includes(label))!;

it(`offers the whole set as one thing to do, and says what each one was read off`, async () => {
    entry = ``;
    setup = undefined;
    recommendations.value = [gitlab, docker];
    const el = mount();

    expect(el.textContent).toContain(`2 capabilities your workspace asks for`);
    // Badged entry carries both the claim and its evidence, in the tooltip rather than two extra lines of entry height.
    const badge = el.querySelector(`[data-tooltip*="your repositories are hosted on your own GitLab"]`);
    expect(badge?.getAttribute(`data-tooltip`)).toContain(`api/.gitlab-ci.yml → git.acme.dev`);

    button(el, `Set them up`).click();
    await nextTick();
    // Into the first entry with the walk running, so the form knows it's a step, not a lone visit.
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ params: { entry: `gitlab` }, query: { setup: `recommended` } }));
});

it(`fills in what the scan could read, and leaves the credential to the user`, async () => {
    entry = `gitlab`;
    setup = `recommended`;
    recommendations.value = [gitlab, docker];
    const el = mount();
    await nextTick();

    // Claim and evidence file print in full above the form, before anything is connected.
    expect(el.textContent).toContain(`your repositories are hosted on your own GitLab`);
    expect(el.textContent).toContain(`api/.gitlab-ci.yml → git.acme.dev`);

    const inputs = [...el.querySelectorAll(`input`)];
    // Pre-filled with the scan's instance, not the entry's gitlab.com default.
    expect(inputs.some((input) => input.value === `https://git.acme.dev`)).toBe(true);
    // Credential is the one thing this flow won't fill in for the user.
    expect(inputs.filter((input) => input.type === `password`).every((input) => input.value === ``)).toBe(true);
    expect(el.textContent).toContain(`2 left`);
});

it(`takes "not needed" as an answer and moves on rather than asking again`, async () => {
    entry = `gitlab`;
    setup = `recommended`;
    recommendations.value = [gitlab, docker];
    dismiss.mockResolvedValue(undefined);
    push.mockClear();
    const el = mount();
    await nextTick();

    button(el, `Not needed`).click();
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith(`gitlab`));
    // Moves straight to the next queued entry, not back to the grid.
    await waitFor(() => expect(push).toHaveBeenCalledWith(expect.objectContaining({ params: { entry: `docker` } })));
});
