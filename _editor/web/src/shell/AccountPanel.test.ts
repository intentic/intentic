import "@intentic/testing/dom";
import { IconStub } from "@intentic/ui/testing";
import PrimeVue from "primevue/config";
import { type App, createApp, h, nextTick, ref } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";

// Sign out that did not sign anybody out says why, in the menu it was pressed in: a local window whose app could not
// reach the platform, or a platform that refused. Until 2026-10-12 the press lock swallowed the rejection, the menu stayed
// as it was, and the reader stayed signed in without a word.

const signOut = jest.fn(async (): Promise<`signed-out` | `switched`> => `signed-out`);
const signOutAll = jest.fn(async (): Promise<void> => undefined);
const refreshOthers = jest.fn(async (): Promise<void> => undefined);
const switchTo = jest.fn(async (_other: unknown): Promise<void> => undefined);
const addRun = jest.fn();
interface Other {
    readonly token: string;
    readonly user: { readonly id: string; readonly email: string; readonly name: string; readonly image: string | null };
}
const others = ref<readonly Other[]>([]);
const canAdd = ref(true);
// How this window adds an account, which a case changes: a path here, the desktop app's hand-off, or none.
type AddRoad = { readonly path: string } | { readonly run: () => void } | undefined;
let addRoad: AddRoad = { path: `/login?add=1` };
const account = {
    user: ref({ id: `u1`, email: `ada@example.com`, name: `Ada`, image: null }),
    refresh: async () => null,
    updateProfile: async () => undefined,
    signOut,
    signOutAll,
    others,
    refreshOthers,
    switchTo,
    get add(): AddRoad {
        return addRoad;
    },
    canAdd,
    settled: async () => undefined,
    local: true,
};
// The browser's other accounts, as the platform lists them: never the one signed in (useAccount.ts).
const WORK: Other = { token: `t-work`, user: { id: `u2`, email: `ada@company.example`, name: `Ada`, image: null } };
const SIDE: Other = { token: `t-side`, user: { id: `u3`, email: `ada@side.example`, name: `Ada`, image: null } };
jest.mock(`../client/auth/useAccount`, () => ({ useAccount: () => account }));
jest.mock(`../models/hosted-plan/useHostedPlan`, () => ({ useHostedPlan: () => ({ planBadge: ref(undefined) }) }));
jest.mock(`../features/gettingStarted/useGettingStarted`, () => ({ useGettingStarted: () => ({ reopenable: ref(false), show: async () => undefined }) }));
jest.mock(`../workbench/commands/useCommands`, () => ({ registerCommand: () => ({ dispose: () => undefined }) }));
jest.mock(`../models/home/sandboxTrash`, () => ({ useDeletedCount: () => ref(0) }));
// The community invitation's state, held here so a case can say whether an ask is waiting (its rules are
// features/community/communityInvite.test.ts).
const invite = {
    url: `https://discord.gg/example`,
    dot: ref(false),
    note: ref(false),
    onFinished: ref(false),
    seen: jest.fn(),
    answer: jest.fn(),
    open: jest.fn(),
};
jest.mock(`../features/community/useCommunityInvite`, () => ({ useCommunityInvite: () => invite }));

const { default: AccountPanel } = await import("./AccountPanel.vue");

let app: App | undefined;
let el: HTMLElement | undefined;
afterEach(() => {
    app?.unmount();
    el?.remove();
    app = undefined;
    signOut.mockReset();
    signOut.mockImplementation(async () => `signed-out`);
    signOutAll.mockReset();
    refreshOthers.mockClear();
    switchTo.mockReset();
    addRun.mockReset();
    others.value = [];
    canAdd.value = true;
    addRoad = { path: `/login?add=1` };
    pushed.length = 0;
    invite.dot.value = false;
    invite.note.value = false;
    invite.seen.mockReset();
    invite.answer.mockReset();
});

// The press settles a few ticks after it lands. Microtasks only: the overlay's own timers are not this test's business.
const settle = async (): Promise<void> => {
    for (let tick = 0; tick < 4; tick += 1) {
        await nextTick();
        await Promise.resolve();
    }
};

// Where the menu sent the reader in this window, address by address.
const pushed: string[] = [];

const mountPanel = async (): Promise<void> => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: `/:all(.*)*`, component: { render: () => null } }] });
    await router.push(`/workspace`);
    router.afterEach((to) => {
        pushed.push(to.fullPath);
    });
    el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(AccountPanel) });
    app.use(router);
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    await router.isReady();
    const trigger = el.querySelector<HTMLButtonElement>(`button[aria-haspopup="dialog"]`);
    if (trigger === null) {
        throw new Error(`the account control did not render`);
    }
    // Where the rail draws it: an anchor with no size is one the overlay closes on rather than points at.
    trigger.getBoundingClientRect = () => DOMRect.fromRect({ x: 8, y: 700, width: 36, height: 36 });
    trigger.click();
    await settle();
};

const found = (test: string): HTMLElement | null => document.body.querySelector<HTMLElement>(`[data-test="${test}"]`);

const pressSignOut = async (): Promise<void> => {
    // The menu's last row, and its only button among them: Settings is a link.
    const row = [...document.body.querySelectorAll<HTMLButtonElement>(`button[data-menu-row]`)].at(-1);
    if (row === undefined) {
        throw new Error(`the menu did not open`);
    }
    row.click();
    await settle();
};

const failure = (): string | undefined => document.body.querySelector(`[data-test="sign-out-failure"]`)?.textContent?.trim();

test(`a sign-out that failed says why in the menu, which stays open on it`, async () => {
    signOut.mockImplementation(async () => {
        throw new Error(`The platform could not be reached.`);
    });
    await mountPanel();
    await pressSignOut();
    expect([signOut.mock.calls.length, failure()]).toEqual([1, `The platform could not be reached.`]);
});

test(`a sign-out that went through says nothing`, async () => {
    await mountPanel();
    await pressSignOut();
    expect([signOut.mock.calls.length, failure()]).toEqual([1, undefined]);
});

// The community's door is in this menu for everyone; the ask itself only when one is waiting, and then quietly.
test(`the menu always holds the community link, opening outside the app`, async () => {
    await mountPanel();
    const row = found(`community-row`);
    expect([row?.getAttribute(`href`), row?.getAttribute(`target`), found(`community-invite`), found(`community-dot`)]).toEqual([
        invite.url,
        `_blank`,
        null,
        null,
    ]);
});

test(`a press on the plain row counts as joining, so nothing asks again`, async () => {
    await mountPanel();
    found(`community-row`)?.addEventListener(`click`, (event) => event.preventDefault());
    found(`community-row`)?.click();
    expect(invite.answer.mock.calls).toEqual([[`menu`, `joined`]]);
});

test(`a waiting ask wears a dot on the avatar and reads as a note inside the menu, said seen once drawn`, async () => {
    invite.dot.value = true;
    invite.note.value = true;
    await mountPanel();
    expect([found(`community-dot`) !== null, found(`community-invite`) !== null, invite.seen.mock.calls]).toEqual([true, true, [[`menu-note`]]]);
});

describe(`the browser's other accounts`, () => {
    const rows = (): string[] => [...document.body.querySelectorAll(`[data-test="other-account"]`)].map((row) => row.textContent?.trim() ?? ``);

    test(`asks for them as the menu opens, and lists each by its address, never the account signed in`, async () => {
        others.value = [WORK, SIDE];
        await mountPanel();
        expect([refreshOthers.mock.calls.length > 0, rows()]).toEqual([true, [WORK.user.email, SIDE.user.email]]);
    });

    test(`a press on one switches to it, and holds the other rows while it does`, async () => {
        others.value = [WORK, SIDE];
        let finish: () => void = () => undefined;
        switchTo.mockImplementation(async () => new Promise<void>((resolve) => (finish = resolve)));
        await mountPanel();
        document.body.querySelector<HTMLButtonElement>(`[data-test="other-account"]`)?.click();
        await settle();
        const buttons = [...document.body.querySelectorAll<HTMLButtonElement>(`[data-test="other-account"]`)];
        expect([switchTo.mock.calls, buttons.map((button) => button.disabled), buttons[0]?.getAttribute(`aria-busy`)]).toEqual([
            [[WORK]],
            [true, true],
            `true`,
        ]);
        finish();
    });

    test(`a switch to a sign-in that ended says so in the menu`, async () => {
        others.value = [WORK];
        switchTo.mockImplementation(async () => {
            throw new Error(`The sign-in for ada@company.example has ended.`);
        });
        await mountPanel();
        document.body.querySelector<HTMLButtonElement>(`[data-test="other-account"]`)?.click();
        await settle();
        expect(failure()).toBe(`The sign-in for ada@company.example has ended.`);
    });

    test(`offers signing out of all of them only beside another account`, async () => {
        await mountPanel();
        expect(found(`sign-out-all`)).toBeNull();
        app?.unmount();
        others.value = [WORK];
        await mountPanel();
        found(`sign-out-all`)?.click();
        await settle();
        expect([signOutAll.mock.calls.length, signOut.mock.calls.length]).toEqual([1, 0]);
    });

    test(`a sign-out that carried on as another account goes nowhere else and says nothing`, async () => {
        others.value = [WORK];
        signOut.mockImplementation(async () => `switched`);
        await mountPanel();
        found(`sign-out`)?.click();
        await settle();
        expect([signOut.mock.calls.length, failure(), pushed]).toEqual([1, undefined, []]);
    });
});

describe(`adding an account`, () => {
    test(`goes to the sign-in screen in its adding mode`, async () => {
        await mountPanel();
        found(`add-account`)?.click();
        // The router's own navigation takes a timer turn past the press.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(pushed).toEqual([`/login?add=1`]);
    });

    test(`in the desktop app, hands the sign-in to the browser instead`, async () => {
        addRoad = { run: addRun };
        await mountPanel();
        found(`add-account`)?.click();
        await settle();
        expect([addRun.mock.calls.length, pushed]).toEqual([1, []]);
    });

    test(`is not offered where this window cannot add one`, async () => {
        addRoad = undefined;
        await mountPanel();
        expect(found(`add-account`)).toBeNull();
    });

    test(`at the browser's limit, stays in the menu but takes no press, saying why`, async () => {
        canAdd.value = false;
        await mountPanel();
        const row = found(`add-account`);
        row?.click();
        await settle();
        expect([row instanceof HTMLButtonElement && row.disabled, row?.getAttribute(`title`) !== null, pushed]).toEqual([true, true, []]);
    });
});
