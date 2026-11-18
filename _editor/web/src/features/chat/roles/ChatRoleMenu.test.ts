// Pins what the picker says before a message goes: which role speaks, whether it can reach an account, and what "no
// role" means on the attended side.
import "@intentic/testing/dom";
import type { AccessProfile } from "@intentic/sandbox-contract/schemas/access-profiles";
import type { Role } from "@intentic/sandbox-contract/schemas/roles";
import { type App, computed, createApp, h, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";
import * as vueRouterOriginal from "vue-router";
import { RouterLinkStub } from "../../../testing/routerLinkStub";
import { activeSandboxId } from "../../../app/storage/activeSandbox";
import { page, toInside } from "../../../lib/routes/links";

// Needs jsdom: the kit's barrel reads matchMedia at import time (its device tracker), which jsdom lacks.

const roles = ref<Role[]>([]);
const connected = ref<string[]>([]);
// The reader's tier: a guest is offered its own roles and nothing wider.
const isGuest = ref(false);
// Whether the reader holds a maintainer's tier, which opens Sandbox ▸ Roles: the way there is offered only to them,
// and never to a guest, whose tier is below every other (useTier's `canShip`).
const maintainer = ref(true);
const canShip = computed(() => maintainer.value && !isGuest.value);
jest.mock(`../../../client/sandbox/useTier`, () => ({ useTier: () => ({ isGuest, canShip }) }));

// What each card may reach: the access profiles listing it.
const profiles = ref<AccessProfile[]>([]);
jest.mock(`../../../models/sandbox/access/useAccessProfiles`, () => ({ useAccessProfiles: () => ({ profiles }) }));

jest.mock(`../../../models/sandbox/roles/useRoles`, () => ({
    useRoles: () => ({
        roles,
        connected,
        isConnected: (id: string) => connected.value.includes(id),
        error: ref(undefined),
        isLoading: ref(false),
    }),
}));

// Router stub keeps real hrefs on "manage roles" links; a push spy wouldn't see them at all.
jest.mock(`vue-router`, () => ({
    ...vueRouterOriginal,
    useRouter: () => ({ push: jest.fn() }) as never,
    RouterLink: RouterLinkStub as never,
}));

const { default: ChatRoleMenu } = await import("./ChatRoleMenu.vue");

let app: App | undefined;
const mount = (picked?: string): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatRoleMenu, { picked, onPicked: (id: string | undefined) => events.push(id) }) });
    // Icon is registered app-wide in the real app.
    app.component(`Icon`, IconStub);
    app.mount(element);
    return element;
};

const events: (string | undefined)[] = [];
const text = (element: HTMLElement): string => element.textContent ?? ``;
const rowLabelled = (element: HTMLElement, label: string): HTMLButtonElement | undefined =>
    [...element.querySelectorAll(`button`)].find((button) => (button.textContent ?? ``).includes(label));
// Rows that navigate are anchors, not buttons.
const linkLabelled = (element: HTMLElement, label: string): HTMLAnchorElement | undefined =>
    [...element.querySelectorAll(`a`)].find((link) => (link.textContent ?? ``).includes(label));

beforeEach(() => {
    // The sandbox a link is made in while no route names one (lib/routes/links.ts `here`).
    activeSandboxId.value = `sb-1`;
    roles.value = [];
    connected.value = [];
    isGuest.value = false;
    maintainer.value = true;
    events.length = 0;
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

// All accounts is a row: picking it clears the role override and keeps every connected account available here.
it(`offers all accounts as a pick, and says what it means here`, () => {
    roles.value = [{ id: `work`, capabilities: [`reddit-work`] }];
    const element = mount(`work`);

    const fullAccess = rowLabelled(element, `All accounts`)!;
    expect(text(fullAccess)).toContain(`Every signed-in account`);
    fullAccess.click();
    expect(events).toEqual([undefined]);
});

// Stays pickable though unsigned in: marking it prevents it from reading as ready when it isn't.
it(`marks a role whose every account is still signed out`, () => {
    roles.value = [{ id: `work`, label: `Work`, capabilities: [`reddit-work`, `x-company`] }];
    expect(text(mount())).toContain(`not signed in yet`);

    connected.value = [`x-company`];
    // One signed-in account is enough to act, so the mark clears.
    app?.unmount();
    expect(text(mount())).not.toContain(`not signed in yet`);
});

// Account ids distinguish reddit-work from reddit-personal; a bound mark alone can't.
it(`names the accounts a role holds, and picks it by id`, () => {
    roles.value = [{ id: `work`, label: `Work`, capabilities: [`reddit-work`, `x-company`] }];
    connected.value = [`reddit-work`, `x-company`];
    const element = mount();

    const row = rowLabelled(element, `Work`)!;
    expect(text(row)).toContain(`reddit-work · x-company`);
    row.click();
    expect(events).toEqual([`work`]);
});

// Same phrase the roles page uses for a bounded role, so the two are recognizably the same role: read off the
// access profile that lists it.
it(`says how bounded a role is`, () => {
    roles.value = [{ id: `visitor`, capabilities: [`reddit-work`] }];
    profiles.value = [{ id: `public`, tools: { files: `read`, shell: false }, roles: [`visitor`] }];
    expect(text(mount())).toContain(`Read-only`);
    profiles.value = [];
});

it(`badges no role that no profile holds`, () => {
    roles.value = [{ id: `writer`, capabilities: [] }];
    expect(text(mount())).not.toContain(`Full powers`);
});

it(`explains the empty workspace and offers the way in`, () => {
    const element = mount();

    expect(text(element)).toContain(`No roles yet`);
    // A real href, so the row can be hovered, copied, and opened in a new tab like any other link.
    expect(linkLabelled(element, `Set up a role`)?.getAttribute(`href`)).toBe(toInside(`sb-1`, page.sandboxSettings(`roles`)));
});

// Sandbox ▸ Roles is a maintainer's section: below that, a link there would only open a gate.
it(`offers no way to the roles page to a member below maintainer`, () => {
    maintainer.value = false;
    const element = mount();

    expect(text(element)).toContain(`No roles yet`);
    expect(linkLabelled(element, `Set up a role`)).toBeUndefined();
});

// A guest holds only its assigned roles; both built-ins and role management stay with the owner.
it(`offers a guest its roles alone: no built-ins, no way to the roles page`, () => {
    isGuest.value = true;
    roles.value = [{ id: `support`, label: `Support`, capabilities: [] }];
    const element = mount(`support`);

    expect(rowLabelled(element, `All accounts`)).toBeUndefined();
    expect(rowLabelled(element, `No accounts`)).toBeUndefined();
    expect(linkLabelled(element, `Manage roles`)).toBeUndefined();
    rowLabelled(element, `Support`)!.click();
    expect(events).toEqual([`support`]);
});

it(`tells a guest with no role yet to ask the owner, rather than offering to set one up`, () => {
    isGuest.value = true;
    const element = mount();

    expect(text(element)).toContain(`No assistant has been assigned to you yet`);
    expect(linkLabelled(element, `Set up a role`)).toBeUndefined();
});
