// @vitest-environment jsdom
// Pins how EnvironmentCard behaves when the daemon predates the contents route (404, since supportsRoute
// can't gate on it): show the recipe and hide the tab, not the inventory itself (contents.integration.test.ts).
import type { Environment } from "@intentic/sandbox-contract";
import { afterEach, expect, it, vi } from "vitest";
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
vi.mock(`./useEnvironment`, () => ({
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
    }),
}));

// Whether this sandbox's daemon knows the contents route; the one flag each test sets.
const unsupported = ref(false);
vi.mock(`./useEnvironmentContents`, () => ({
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
vi.mock(`../client/useSandbox`, () => ({
    useSandbox: () => ({ active, daemonUrl: ref(undefined), reachable: ref(true) }),
    sandboxKey: (name: string) => [name],
}));
vi.mock(`@tanstack/vue-query`, () => ({ useQueryClient: () => ({ setQueryData: () => {} }) }));
// Mocked as a module: agentActions reaches the shared query client and chat broadcast singletons, which
// are out of this suite's subject and fail at import if left real.
vi.mock(`../../agents/fleet/agentActions`, () => ({ startAgent: () => `` }));
// Each reaches the daemon on its own; mocked here only so mounting the card doesn't.
vi.mock(`../../workspace/viewers/DiffView.vue`, () => ({ default: defineComponent({ render: () => null }) }));
vi.mock(`../../workspace/viewers/DiffToolbar.vue`, () => ({ default: defineComponent({ render: () => null }) }));
// Marks each executor with data-executor, so a test can tell which one rendered without mounting it.
vi.mock(`../../capabilities/connect/HostRecreate.vue`, () => ({ default: defineComponent({ render: () => h(`div`, { "data-executor": `host` }) }) }));
vi.mock(`./HostedRebuild.vue`, () => ({ default: defineComponent({ render: () => h(`div`, { "data-executor": `hosted` }) }) }));

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

it(`stands down once the only runtime installs left are ones you dismissed`, () => {
    applied.value = undefined;
    recurring.value = [{ tool: `chromium-headless-shell`, kind: `playwright`, sessions: 2, lastAt: 1_756_000_000_000, live: true }];
    expect(mount().textContent).toContain(`Installed at runtime`);
    app?.unmount();
    document.body.innerHTML = ``;

    recurring.value = [{ ...recurring.value[0]!, declined: true }];
    expect(mount().textContent).toBe(``);
});
