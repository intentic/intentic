// Pins how EnvironmentCard behaves when the daemon predates the contents route (404, since supportsRoute
// can't gate on it): show the recipe and hide the tab, not the inventory itself (contents.integration.test.ts). And
// where its one next step goes: first, above the contents and the runtime installs, never trailing them.
import "@intentic/testing/dom";
import type { Environment } from "@intentic/sandbox-contract";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

// An applied overlay and nothing pending, the ordinary baseline state.
const OVERLAY = `FROM ghcr.io/intentic/sandbox:stable\n\n# ---- ffmpeg ----\nRUN apt-get install -y ffmpeg\n`;
const environment: Environment = {
    approved: { content: OVERLAY, hash: `abc` },
    custom: { content: `# ---- ffmpeg ----\nRUN apt-get install -y ffmpeg\n`, hash: `def` },
    appliedHash: `abc`,
    container: `intentic-sandbox-demo`,
};

// An approved overlay not yet built; undefined is the ordinary applied state.
const pending = ref<Environment[`approved`] | undefined>(undefined);
// The built overlay and the runtime-install attention list; the card renders only when either is set.
const applied = ref<Environment[`approved`] | undefined>(environment.approved);
const recurring = ref<NonNullable<Environment[`recurring`]>>([]);
// Set only on a sandbox whose base was compiled from a checkout; undefined is every published sandbox.
const localImage = ref<Environment[`localImage`]>(undefined);
// A change an agent drafted, waiting for the owner's decision; undefined is the ordinary state.
const proposal = ref<Environment[`proposal`]>(undefined);
jest.mock(`./useEnvironment`, () => ({
    ENVIRONMENT_KEY: [`environment`],
    useEnvironment: () => ({
        state: ref(environment),
        query: { refetch: () => {} },
        // The refresh spinner's flag; must be mocked or it reads as permanently fetching.
        isFetching: ref(false),
        proposal,
        pending,
        applied,
        recurring,
        serverManaged: ref(false),
        slug: ref(`demo`),
        localImage,
    }),
}));

jest.mock(`./useEnvironmentContents`, () => ({
    useEnvironmentContents: () => ({
        groups: ref([]),
        awaiting: ref(0),
        loading: ref(false),
        error: ref(undefined),
        refresh: () => {},
    }),
}));
// The active sandbox as the platform describes it; `hosted` selects the rebuild executor.
const active = ref<{ id: string; role: string; hosted?: { region: string; warm: boolean } | null }>({ id: `sb1`, role: `owner` });
jest.mock(`../client/useSandbox`, () => ({
    useSandbox: () => ({ active, daemonUrl: ref(undefined), reachable: ref(true) }),
    sandboxKey: (name: string) => [name],
}));
jest.mock(`@tanstack/vue-query`, () => ({ useQueryClient: () => ({ setQueryData: () => {} }) }));
// Every decision the card posts is refused, so a test can see where the refusal is said.
const sandboxJson = jest.fn(async (..._request: unknown[]): Promise<never> => {
    throw new Error(`the daemon said no`);
});
jest.mock(`../client/sandboxClient`, () => ({ sandboxJson: (...request: unknown[]) => sandboxJson(...request) }));
// Mocked as a module: agentActions reaches the shared query client and chat broadcast singletons, which
// are out of this suite's subject and fail at import if left real.
jest.mock(`../../agents/fleet/agentActions`, () => ({ startAgent: () => `` }));
// Each reaches the daemon on its own; mocked here only so mounting the card doesn't.
jest.mock(`../../workspace/viewers/DiffView.vue`, () => ({ default: defineComponent({ render: () => null }) }));
jest.mock(`../../workspace/viewers/DiffToolbar.vue`, () => ({ default: defineComponent({ render: () => null }) }));
// Marks each executor with data-executor, so a test can tell which one rendered without mounting it. The host one
// carries out whether it was asked for its cost line (`bare` drops it) and for the tier below the step (`text`).
jest.mock(`../../capabilities/connect/hosts/HostRecreate.vue`, () => ({
    default: defineComponent({
        props: { bare: { type: Boolean, default: false }, text: { type: Boolean, default: false } },
        render(): ReturnType<typeof h> {
            return h(`div`, { "data-executor": `host`, "data-bare": String(this.bare), "data-text": String(this.text) });
        },
    }),
}));
jest.mock(`./rebuild/HostedRebuild.vue`, () => ({ default: defineComponent({ render: () => h(`div`, { "data-executor": `hosted` }) }) }));

const { default: EnvironmentCard } = await import("./EnvironmentCard.vue");

let app: App | undefined;
const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(EnvironmentCard) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    // Renders an anchor so the Sandbox tab link doesn't need a router.
    app.component(`RouterLink`, defineComponent({ props: { to: { type: String, default: `` } }, setup: (props, { slots }) => () => h(`a`, { href: props.to }, slots.default?.()) }));
    app.mount(el);
    return el;
};

afterEach(() => {
    pending.value = undefined;
    proposal.value = undefined;
    sandboxJson.mockClear();
    applied.value = environment.approved;
    recurring.value = [];
    localImage.value = undefined;
    active.value = { id: `sb1`, role: `owner` };
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`offers both reads when the daemon can answer for its contents`, () => {
    const el = mount();
    expect([...el.querySelectorAll(`[role="tab"]`)].map((tab) => tab.textContent?.trim())).toEqual([`Contents`, `Recipe`]);
    expect(el.textContent).not.toContain(`Active overlay`);
});

it(`hands a pending overlay to the host executor on a sandbox the owner runs`, () => {
    pending.value = { content: OVERLAY, hash: `pending` };
    const el = mount();
    expect(el.querySelector(`[data-executor="host"]`)).not.toBeNull();
    expect(el.querySelector(`[data-executor="hosted"]`)).toBeNull();
});

it(`hands a pending overlay to the platform's builder on a hosted sandbox`, () => {
    pending.value = { content: OVERLAY, hash: `pending` };
    active.value = { id: `sb1`, role: `owner`, hosted: { region: `iad`, warm: true } };
    const el = mount();
    expect(el.querySelector(`[data-executor="hosted"]`)).not.toBeNull();
    expect(el.querySelector(`[data-executor="host"]`)).toBeNull();
});

// A checkout-built sandbox builds its recipe by rebuilding from source, and that button lives on the Sandbox tab
// only: here the card points there, and nowhere else, since every other sandbox has no checkout to rebuild from.
it(`points a checkout-built sandbox's waiting recipe to the Sandbox tab instead of offering the rebuild here`, () => {
    pending.value = { content: OVERLAY, hash: `pending` };
    expect(mount().querySelector(`[data-executor="checkout"]`)).toBeNull();
    app?.unmount();
    document.body.innerHTML = ``;

    localImage.value = { base: `intentic-sandbox:dev`, root: `/home/ada/intentic` };
    const el = mount();
    expect(el.querySelector(`[data-executor="host"]`)).toBeNull();
    expect(el.querySelector(`[data-executor="checkout"] a`)?.getAttribute(`href`)).toBe(`/sandbox`);
    expect(el.querySelector(`button`)?.textContent ?? ``).not.toContain(`Rebuild from checkout`);
});

// Nothing pending: rebuilding from the checkout is only picking up code, which the Sandbox tab's Update card offers.
// The same button on two tabs read as two different actions, so this card leaves it there.
it(`leaves the checkout's rebuild to the Sandbox tab when nothing is pending`, () => {
    localImage.value = { base: `intentic-sandbox:dev`, root: `/home/ada/intentic` };
    const el = mount();
    expect(el.querySelector(`[data-executor="checkout"]`)).toBeNull();
    expect(el.querySelector(`[data-executor="host"]`)).toBeNull();
});

// THE STEP LEADS. Trailing the card, the rebuild sat right under "Installed at runtime" and read as an action on
// those rows, which carry decisions of their own; the card's own step is drawn first, and the list ends the card.
it(`puts the rebuild above the contents and the runtime installs, with no paragraph under its button`, () => {
    pending.value = { content: OVERLAY, hash: `pending` };
    recurring.value = [{ tool: `chromium-headless-shell`, kind: `playwright`, sessions: 2, lastAt: 1_756_000_000_000, live: true }];
    const el = mount();
    const rebuild = el.querySelector(`[data-executor="host"]`);
    const runtime = [...el.querySelectorAll(`span`)].find((span) => span.textContent === `Installed at runtime`);
    // The innermost block that opens on the contents' own sentence: every wrapper around it opens on it too.
    const contents = [...el.querySelectorAll(`div`)].findLast((div) => div.textContent?.startsWith(`Nothing added on top of the stock image yet`));
    expect(rebuild?.getAttribute(`data-bare`)).toBe(`true`);
    expect(rebuild?.compareDocumentPosition(runtime!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(rebuild?.compareDocumentPosition(contents!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(el.textContent).not.toContain(`To finish, rebuild your sandbox`);
});

// Approving changes what the rebuild builds, so a waiting proposal is decided first, and a rebuild offered beside it
// steps down a tier rather than competing with it.
it(`asks for the decision before the build, and draws the build a tier down while a proposal waits`, () => {
    pending.value = { content: OVERLAY, hash: `pending` };
    proposal.value = { content: `${OVERLAY}RUN apt-get install -y imagemagick\n`, hash: `proposed` };
    const el = mount();
    const approve = [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Approve`));
    const rebuild = el.querySelector(`[data-executor="host"]`);
    expect(approve?.compareDocumentPosition(rebuild!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(rebuild?.getAttribute(`data-text`)).toBe(`true`);
});

// One card, two places a decision is pressed: the proposal's at the top, a runtime install's at the foot of its list.
// A refusal is said beside whichever drew it, since the other one is a whole inventory away.
it(`says a refusal beside the button that drew it`, async () => {
    proposal.value = { content: `${OVERLAY}RUN apt-get install -y imagemagick\n`, hash: `proposed` };
    recurring.value = [{ tool: `chromium-headless-shell`, kind: `playwright`, sessions: 2, lastAt: 1_756_000_000_000, live: true }];
    const el = mount();
    const runtime = (): Element => [...el.querySelectorAll(`span`)].find((span) => span.textContent === `Installed at runtime`)!;
    const refusal = (): Element | undefined => [...el.querySelectorAll(`[role="alert"]`)].find((alert) => alert.textContent?.includes(`the daemon said no`));

    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Approve`))?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(refusal()?.textContent).toContain(`Could not update the environment.`);
    expect(refusal()?.compareDocumentPosition(runtime())).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    el.querySelector<HTMLElement>(`section section button[aria-expanded]`)?.click();
    await nextTick();
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Dismiss`))?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(refusal()?.compareDocumentPosition(runtime())).toBe(Node.DOCUMENT_POSITION_PRECEDING);
    expect(sandboxJson).toHaveBeenCalledTimes(2);
});

it(`stands down once the only runtime installs left are ones you dismissed`, () => {
    applied.value = undefined;
    recurring.value = [{ tool: `chromium-headless-shell`, kind: `playwright`, sessions: 2, lastAt: 1_756_000_000_000, live: true }];
    expect(mount().textContent).toContain(`Installed at runtime`);
    app?.unmount();
    document.body.innerHTML = ``;

    recurring.value = [{ ...recurring.value[0]!, declined: true }];
    expect(mount().textContent).toBe(``);
});
