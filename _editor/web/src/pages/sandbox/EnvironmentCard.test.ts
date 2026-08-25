// @vitest-environment jsdom
//
// THE SUBJECT IS A BROWSER NEWER THAN ITS DAEMON, which is a supported state and not a fault (useDaemonRoutes):
// the app plane serves whatever image a user last pulled, and in local development the web app runs from the
// working tree while the daemon is the last one built. The contents view is a hand-written Hono route, so the
// daemon never advertises it by name and `supportsRoute` cannot gate on it: a 404 is the only signal there is.
//
// Shipped without this the card offered a tab whose only greeting was "Could not read what the sandbox has
// installed · Request failed (404)", i.e. a working sandbox reading as a broken feature. What is pinned here is
// therefore not the inventory (contents.integration.test.ts has that) but that a daemon which cannot answer gets
// the recipe it has always been able to show, and that the tab is not offered at all.
import type { Environment } from "@intentic/sandbox-contract";
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, ref } from "vue";

// An applied overlay and nothing pending: the ordinary state, so what varies between tests is only whether the
// daemon can answer for its contents.
const OVERLAY = `FROM ghcr.io/intentic/sandbox:stable\n\n# ---- ffmpeg ----\nRUN apt-get install -y ffmpeg\n`;
const environment: Environment = {
    approved: { content: OVERLAY, hash: `abc` },
    custom: { content: `# ---- ffmpeg ----\nRUN apt-get install -y ffmpeg\n`, hash: `def` },
    appliedHash: `abc`,
    container: `intentic-sandbox-demo`,
};

vi.mock(`../../composables/sandbox/useEnvironment`, () => ({
    ENVIRONMENT_KEY: [`environment`],
    useEnvironment: () => ({
        state: ref(environment),
        query: { refetch: () => {} },
        proposal: ref(undefined),
        pending: ref(undefined),
        applied: ref(environment.approved),
        recurring: ref([]),
        serverManaged: ref(false),
        slug: ref(`demo`),
    }),
}));

// Whether THIS sandbox's daemon knows the contents route. The one thing each test sets.
const unsupported = ref(false);
vi.mock(`../../composables/sandbox/useEnvironmentContents`, () => ({
    useEnvironmentContents: () => ({
        groups: ref([]),
        awaiting: ref(0),
        loading: ref(false),
        error: ref(unsupported.value ? `Request failed (404).` : undefined),
        unsupported,
        refresh: () => {},
    }),
}));
vi.mock(`../../composables/sandbox/useSandbox`, () => ({
    useSandbox: () => ({ active: ref({ role: `owner` }), daemonUrl: ref(undefined), reachable: ref(true) }),
    sandboxKey: (name: string) => [name],
}));
vi.mock(`@tanstack/vue-query`, () => ({ useQueryClient: () => ({ setQueryData: () => {} }) }));
// The diff viewer and the rebuild one-liner each reach the daemon on their own; this mounts the card.
vi.mock(`../workspace/viewers/DiffView.vue`, () => ({ default: defineComponent({ render: () => null }) }));
vi.mock(`../workspace/viewers/DiffToolbar.vue`, () => ({ default: defineComponent({ render: () => null }) }));
vi.mock(`../../components/HostRecreate.vue`, () => ({ default: defineComponent({ render: () => null }) }));

const { default: EnvironmentCard } = await import("./EnvironmentCard.vue");

let app: App | undefined;
const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(EnvironmentCard) });
    app.component(`Icon`, defineComponent({ props: { name: String }, render: () => h(`i`) }));
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

afterEach(() => {
    unsupported.value = false;
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`offers both reads when the daemon can answer for its contents`, () => {
    const el = mount();
    expect([...el.querySelectorAll(`[role="tab"]`)].map((tab) => tab.textContent?.trim())).toEqual([`Contents`, `Recipe`]);
    // Contents leads: the recipe is behind the pill, not on screen beside it.
    expect(el.textContent).not.toContain(`Active overlay`);
});

it(`falls back to the recipe on a daemon that predates the contents route, and stops offering the tab`, () => {
    unsupported.value = true;
    const el = mount();
    // No tab row at all: a choice whose one option 404s is not a choice.
    expect(el.querySelectorAll(`[role="tab"]`)).toHaveLength(0);
    // What every daemon with an overlay can show, shown.
    expect(el.textContent).toContain(`Active overlay`);
    /* And the reason, once, quietly, the image's age, not a fault. It has to send them to an UPDATE: an
     * environment rebuild builds on top of the image this sandbox already runs, so it is the one action that
     * would not bring this, and pointing there would cost them a rebuild to learn so. */
    expect(el.textContent).toContain(`image is older than the plain-language contents list`);
    expect(el.textContent).toContain(`Update the sandbox`);
    // Never the raw refusal the generic error path would have drawn.
    expect(el.textContent).not.toContain(`404`);
    expect(el.textContent).not.toContain(`Could not read what the sandbox has installed`);
});
