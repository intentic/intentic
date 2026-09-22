// Pins how EnvironmentCard behaves when the daemon predates the contents route (404, since supportsRoute
// can't gate on it): show the recipe and hide the tab, not the inventory itself (contents.integration.test.ts).
import "@intentic/testing/dom";
import type { Environment } from "@intentic/sandbox-contract";
import { it, expect, afterEach, mock } from "bun:test";
import { type App, createApp, defineComponent, h, ref } from "vue";
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
mock.module(`./useEnvironment`, () => ({
    ENVIRONMENT_KEY: [`environment`],
    useEnvironment: () => ({
        state: ref(environment),
        query: { refetch: () => {} },
        // The refresh spinner's flag; must be mocked or it reads as permanently fetching.
        isFetching: ref(false),
        proposal: ref(undefined),
        pending,
        applied,
        recurring,
        serverManaged: ref(false),
        slug: ref(`demo`),
        localImage,
    }),
}));

// Whether this sandbox's daemon knows the contents route; the one flag each test sets.
const unsupported = ref(false);
mock.module(`./useEnvironmentContents`, () => ({
    useEnvironmentContents: () => ({
        groups: ref([]),
        awaiting: ref(0),
        loading: ref(false),
        error: ref(unsupported.value ? `Request failed (404).` : undefined),
        unsupported,
        refresh: () => {},
    }),
}));
// The active sandbox as the platform describes it; `hosted` selects the rebuild executor.
const active = ref<{ id: string; role: string; hosted?: { region: string; warm: boolean } | null }>({ id: `sb1`, role: `owner` });
mock.module(`../client/useSandbox`, () => ({
    useSandbox: () => ({ active, daemonUrl: ref(undefined), reachable: ref(true) }),
    sandboxKey: (name: string) => [name],
}));
mock.module(`@tanstack/vue-query`, () => ({ useQueryClient: () => ({ setQueryData: () => {} }) }));
// Mocked as a module: agentActions reaches the shared query client and chat broadcast singletons, which
// are out of this suite's subject and fail at import if left real.
mock.module(`../../agents/fleet/agentActions`, () => ({ startAgent: () => `` }));
// Each reaches the daemon on its own; mocked here only so mounting the card doesn't.
mock.module(`../../workspace/viewers/DiffView.vue`, () => ({ default: defineComponent({ render: () => null }) }));
mock.module(`../../workspace/viewers/DiffToolbar.vue`, () => ({ default: defineComponent({ render: () => null }) }));
// Marks each executor with data-executor, so a test can tell which one rendered without mounting it.
mock.module(`../../capabilities/connect/HostRecreate.vue`, () => ({ default: defineComponent({ render: () => h(`div`, { "data-executor": `host` }) }) }));
mock.module(`./HostedRebuild.vue`, () => ({ default: defineComponent({ render: () => h(`div`, { "data-executor": `hosted` }) }) }));
// Carries `recipePending` out with it: whether the checkout's rebuild knows a recipe is waiting is what makes it
// describe itself as applying that recipe rather than as a second, unrelated rebuild.
mock.module(`./DevRebuild.vue`, () => ({
    default: defineComponent({
        props: { recipePending: { type: Boolean, default: false } },
        render(): ReturnType<typeof h> {
            return h(`div`, { "data-executor": `checkout`, "data-recipe-pending": String(this.recipePending) });
        },
    }),
}));

const { default: EnvironmentCard } = await import("./EnvironmentCard.vue");

let app: App | undefined;
const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(EnvironmentCard) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

afterEach(() => {
    unsupported.value = false;
    pending.value = undefined;
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

it(`falls back to the recipe on a daemon that predates the contents route, and stops offering the tab`, () => {
    unsupported.value = true;
    const el = mount();
    expect(el.querySelectorAll(`[role="tab"]`)).toHaveLength(0);
    expect(el.textContent).toContain(`Active overlay`);
    expect(el.textContent).toContain(`image is older than the plain-language contents list`);
    expect(el.textContent).toContain(`Update the sandbox`);
    expect(el.textContent).not.toContain(`404`);
    expect(el.textContent).not.toContain(`Could not read what the sandbox has installed`);
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

// A checkout-built sandbox is the one shape where the image itself can be behind the code, so the offer that rebuilds
// it from source belongs here — and nowhere else, since every other sandbox has no checkout to rebuild from.
it(`offers a rebuild from the checkout only on a sandbox whose base was built from one`, () => {
    expect(mount().querySelector(`[data-executor="checkout"]`)).toBeNull();
    app?.unmount();
    document.body.innerHTML = ``;

    localImage.value = { base: `intentic-sandbox:dev`, root: `/home/ada/intentic` };
    expect(mount().querySelector(`[data-executor="checkout"]`)).not.toBeNull();
});

// Two rebuilds on one card: the recipe's, which applies what was approved to the image already built, and the
// checkout's, which builds a new base and applies the same recipe on it. The second is told about the first HERE,
// through the offer itself — a sentence under the other button is the shape that had a reader press the slow one
// believing it was the same thing.
it(`tells the checkout's rebuild that a recipe is waiting, so it can say it applies that recipe too`, () => {
    pending.value = { content: OVERLAY, hash: `pending` };
    localImage.value = { base: `intentic-sandbox:dev`, root: `/home/ada/intentic` };
    const el = mount();
    expect(el.querySelector(`[data-executor="host"]`)).not.toBeNull();
    expect(el.querySelector(`[data-executor="checkout"]`)?.getAttribute(`data-recipe-pending`)).toBe(`true`);
});

// Nothing pending is the dev loop's ordinary state, and there the checkout rebuild is the card's only action: it has
// no recipe to speak for, and claiming one would be the same misdirection pointed the other way.
it(`leaves the checkout's rebuild speaking only for itself when nothing is pending`, () => {
    localImage.value = { base: `intentic-sandbox:dev`, root: `/home/ada/intentic` };
    const el = mount();
    expect(el.querySelector(`[data-executor="host"]`)).toBeNull();
    expect(el.querySelector(`[data-executor="checkout"]`)?.getAttribute(`data-recipe-pending`)).toBe(`false`);
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
