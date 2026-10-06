import "@intentic/testing/dom";
import type { SandboxSummary } from "@intentic/api-contract";
import { unstubbed } from "@intentic/testing";
import { waitFor } from "@intentic/testing/bun";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, h, nextTick, ref } from "vue";
import * as actualVueRouter from "vue-router";
import { RouterLinkStub } from "../../../testing/routerLinkStub";
import type { RememberedSandbox } from "../../../client/directory/deviceDirectory";
import type { RecoveryDeps } from "./useRecovery";

// The recovery screen as the reader meets it: the sandboxes it can bring back, one press each, and somewhere to go once
// nothing is left. The order of the work underneath is useRecovery.test.ts's; here the deps only stand in for it.

const push = jest.fn();
const replace = jest.fn();
// SAFETY: the screen reads only `query` off the route and only push/replace off the router, and renders RouterLink, which
// the stub stands in for; the casts below are of exactly those.
jest.mock(`vue-router`, () => ({
    ...actualVueRouter,
    useRoute: () => ({ query: {} }) as never,
    useRouter: () => ({ push, replace }) as never,
    RouterLink: RouterLinkStub as never,
}));

const owner = { id: `u1`, email: `owner@example.com`, name: `Owner`, image: null };
jest.mock(`../../../client/auth/useAuth`, () => ({ useAuth: () => ({ user: ref(owner) }) }));
const sandboxes = ref<SandboxSummary[]>([]);
jest.mock(`../../../client/sandbox/useSandbox`, () => ({ useSandbox: () => ({ sandboxes }) }));

const intentic: RememberedSandbox = {
    id: `s1`,
    name: `intentic`,
    image: null,
    daemonUrl: `https://sandbox-82789f4106b4.radarsu.com`,
    role: `owner`,
    hosted: false,
    lastSeenAt: `2026-10-01T18:00:09.479Z`,
    missingSince: `2026-10-02T12:00:00.000Z`,
};
const candidates = ref<RememberedSandbox[]>([]);
const relink = jest.fn<RecoveryDeps[`relink`]>(async () => ({ announce: { state: `registered`, at: 0 } }));
jest.mock(`./recoveryDeps`, () => ({
    liveRecoveryDeps: () =>
        unstubbed<RecoveryDeps>(`recovery`, {
            candidates: () => candidates.value,
            health: async () => ({ sandboxId: `82789f4106b4` }),
            lookup: async (ids) => ids.map((sandboxId) => ({ sandboxId, standing: `unknown` as const })),
            ticket: async (sandboxId) => ({ ticket: `at1.${sandboxId}`, expiresAt: `2026-10-02T12:10:00.000Z` }),
            bearer: async () => `daemon-session`,
            relink,
            refreshList: async () => [],
            forget: () => undefined,
        }),
}));

const { default: Recover } = await import(`./Recover.vue`);
const { forgetAccount, rememberListed } = await import(`../../../client/directory/deviceDirectory`);
const { sandboxSummary } = await import(`../../../testing/sandboxSummary`);

let app: App | undefined;
const mount = async (): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(Recover) });
    app.component(`Icon`, IconStub);
    app.mount(el);
    await nextTick();
    return el;
};
const buttonLabelled = (el: HTMLElement, text: string): HTMLButtonElement | undefined =>
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === text);

beforeEach(() => {
    push.mockReset();
    replace.mockReset();
    relink.mockClear();
    candidates.value = [intentic];
    sandboxes.value = [];
    forgetAccount(owner.email);
});
afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.replaceChildren();
});

it(`offers back a sandbox intentic lost track of, and reconnects it with one press`, async () => {
    const el = await mount();
    await waitFor(() => expect(el.textContent).toContain(`Running. intentic has no record of it.`));
    expect(el.textContent).toContain(`intentic lost track of these sandboxes`);

    buttonLabelled(el, `Reconnect`)!.click();
    await waitFor(() => expect(el.textContent).toContain(`Back in your list.`));
    expect(relink).toHaveBeenCalledTimes(1);

    buttonLabelled(el, `Open workspace`)!.click();
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/`));
});

it(`says the records were reset when the platform answered from another database`, async () => {
    const row = sandboxSummary({ id: `s1`, daemonUrl: intentic.daemonUrl, lastSeenAt: intentic.lastSeenAt });
    rememberListed(owner, [row], `id-1`);
    rememberListed(owner, [], `id-2`);
    const el = await mount();
    await waitFor(() => expect(el.textContent).toContain(`intentic's records were reset`));
});

it(`sends the reader to setup when there is nothing to bring back and no workspace`, async () => {
    candidates.value = [];
    await mount();
    await waitFor(() => expect(replace).toHaveBeenCalledWith(`/setup`));
});

it(`sends the reader to the workspace when there is nothing to bring back but one to open`, async () => {
    candidates.value = [];
    sandboxes.value = [sandboxSummary({ id: `s9`, lastSeenAt: `2026-10-02T00:00:00.000Z` })];
    await mount();
    await waitFor(() => expect(replace).toHaveBeenCalledWith(`/`));
});
