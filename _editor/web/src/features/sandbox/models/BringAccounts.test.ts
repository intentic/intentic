// Sandbox ▸ Models' "From your other sandboxes": every other sandbox of the owner's is read without being asked, what
// they hold that this one does not is listed with where it is, and one or all of it is brought in; a sandbox it could not
// see into is named with why, so the section never just vanishes. The far and near calls are the fakes below; the press's
// own order of them is shareAccounts.test.ts's to check.
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import type { AccountsBorrow, AccountsBorrowed, ShareableAccounts } from "@intentic/sandbox-contract/schemas/providers/account-sharing";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { waitFor } from "@intentic/testing/bun";
import { IconStub } from "@intentic/ui/testing";
import PrimeVue from "primevue/config";
import { type App, computed, createApp, h, nextTick, ref } from "vue";
import { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";

const HERE = { id: `sbx-shop`, name: `acme-shop`, daemonUrl: `https://shop.example`, role: `owner`, removedAt: null };
const LAPTOP = { id: `sbx-laptop`, name: `ada-laptop`, daemonUrl: `https://laptop.example`, role: `owner`, removedAt: null };
const DESK = { id: `sbx-desk`, name: `ada-desk`, daemonUrl: `https://desk.example`, role: `maintainer`, removedAt: null };
const GUEST = { id: `sbx-guest`, name: `friend`, daemonUrl: `https://friend.example`, role: `guest`, removedAt: null };
const ASLEEP = { id: `sbx-asleep`, name: `ada-old`, daemonUrl: null, role: `owner`, removedAt: null };
const sandboxes = ref<unknown[]>([HERE, LAPTOP, GUEST]);
jest.mock(`../../../client/sandbox/useSandbox`, () => ({
    useSandbox: () => ({
        sandboxes,
        active: computed(() => HERE),
        activeSandboxId: computed(() => HERE.id),
        daemonUrl: computed(() => HERE.daemonUrl),
        reachable: ref(true),
    }),
}));
jest.mock(`../../../client/sandbox/useRole`, () => ({ useRole: () => ({ canShip: computed(() => true) }) }));
const borrowSupported = ref(true);
jest.mock(`../../../client/sandbox/useDaemonRoutes`, () => ({ supportsRoute: () => borrowSupported.value }));
jest.mock(`../../../parts/sandbox/SandboxOutdatedNotice.vue`, () => ({
    default: { props: [`missing`], render(this: { missing: string }) { return h(`div`, `Update needed: ${this.missing}`); } },
}));

const capabilities = ref<CapabilitySummary[]>([]);
const add = jest.fn(async () => undefined);
const refetch = jest.fn(async () => ({ data: { capabilities: capabilities.value, recommendations: [] } }));
jest.mock(`../../../models/capabilities/useCapabilities`, () => ({ useCapabilities: () => ({ capabilities, add, refetch }) }));

// What this sandbox already holds, per provider.
const held = ref<Record<string, readonly OauthAccount[]>>({});
jest.mock(`../../../models/conversations/accounts/useChat-accounts`, () => ({ accountsOf: (provider: string) => held.value[provider] ?? [] }));

const LISTING: ShareableAccounts = {
    sandbox: `ada-laptop`,
    accounts: [
        { provider: `claude`, account: `acc_max`, label: `Claude Max`, email: `ada@acme.dev`, mode: `lend` },
        { provider: `cursor`, account: `cur_1`, label: `Work`, email: `ada@acme.dev`, mode: `copy` },
        { provider: `endpoint/openrouter`, label: `openrouter`, mode: `copy` },
        { provider: `codex`, label: `ChatGPT`, email: `ada@acme.dev`, mode: `no`, reason: `Subscriptions stay on the sandbox that holds them for now.` },
    ],
};
const DESK_LISTING: ShareableAccounts = {
    sandbox: `ada-desk`,
    accounts: [
        // The laptop's own Claude, borrowed by the desk: one account, listed once, from where it can come.
        { provider: `claude`, account: `lent-1`, label: `Claude Max`, email: `ada@acme.dev`, mode: `no`, reason: `It is borrowed from ada-laptop.` },
        { provider: `devin`, account: `dev_1`, label: `Devin`, email: `ops@acme.dev`, mode: `copy` },
    ],
};
const shareableAt = jest.fn(async (id: string): Promise<ShareableAccounts> => (id === DESK.id ? DESK_LISTING : LISTING));
const borrowHere = jest.fn(
    async (ask: AccountsBorrow): Promise<AccountsBorrowed> => ({
        results: ask.items.map((item) =>
            item.provider === `cursor`
                ? { ...item, outcome: `failed` as const, message: `That key has expired on ada-laptop.` }
                : { ...item, outcome: item.provider === `claude` ? (`borrowed` as const) : (`copied` as const), id: `here-1` },
        ),
    }),
);
const mintAt = jest.fn(async (_id: string, _mint: unknown) => ({ id: `lnk_new`, token: `ilk_secret` }));
const accountsMoved = jest.fn(async () => undefined);
jest.mock(`./useAccountSharing`, () => ({
    shareableAt,
    borrowHere,
    accountsMoved,
    useBorrowedAccounts: () => ({ query: { data: ref({ accounts: [] }) } }),
    farShareCalls: { linksAt: async () => [], retermAt: async () => undefined, mintAt, revokeAt: async () => undefined },
}));

const { default: BringAccounts } = await import("./BringAccounts.vue");
const { forgetOperations } = await import("../../../workbench/operations/operations");

let app: App | undefined;
const signIns: string[] = [];
const mount = async (): Promise<void> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(BringAccounts, { onSignIn: (provider: string) => signIns.push(provider) }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.use(PrimeVue);
    app.mount(el);
    await settle();
};
const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
};
const shown = (): string => document.body.textContent ?? ``;
const buttons = (label: string): HTMLButtonElement[] =>
    [...document.body.querySelectorAll<HTMLButtonElement>(`button`)].filter((button) => button.textContent?.trim() === label);
// The nearest box around an element that names `title`: the row it is drawn on.
const rowAround = (element: Element | undefined, title: string): Element | undefined => {
    let node = element?.parentElement ?? undefined;
    while (node !== undefined && node.textContent?.includes(title) !== true) {
        node = node.parentElement ?? undefined;
    }
    return node;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    signIns.length = 0;
    capabilities.value = [];
    held.value = {};
    sandboxes.value = [HERE, LAPTOP, GUEST];
    borrowSupported.value = true;
    for (const fake of [add, refetch, shareableAt, borrowHere, mintAt, accountsMoved]) {
        fake.mockClear();
    }
    forgetOperations();
    resetSandboxScope();
});

it(`reads every other sandbox the owner may make a link on, without a pick, and says where each account is`, async () => {
    await mount();
    expect(shown()).toContain(`From your other sandboxes`);
    // Only the laptop: this sandbox is not asked, and a guest's sandbox is not the reader's to make a link on.
    expect(shareableAt.mock.calls.map(([id]) => id)).toEqual([LAPTOP.id]);
    await waitFor(() => expect(shown()).toContain(`Claude Max`));
    // The way each comes first on its line, then where it is, then whose it is.
    expect(shown()).toContain(`Borrow turn by turn · on ada-laptop · ada@acme.dev`);
    expect(shown()).toContain(`Copy its key · on ada-laptop · Cursor · ada@acme.dev`);
    expect(shown()).toContain(`Copy its key · on ada-laptop · Model endpoint`);
    expect(shown()).toContain(`Subscriptions stay on the sandbox that holds them for now · on ada-laptop · ada@acme.dev`);
    // Claude, Cursor and the endpoint can come; ChatGPT cannot, and offers signing in here instead.
    expect(buttons(`Bring`)).toHaveLength(3);
    expect(buttons(`Sign in here instead`)).toHaveLength(1);
    expect(buttons(`Bring all`)).toHaveLength(1);

    buttons(`Sign in here instead`)[0]?.click();
    expect(signIns).toEqual([`codex`]);
});

it(`leaves out what is already here, and lists an account two sandboxes hold once, from where it can come`, async () => {
    sandboxes.value = [HERE, LAPTOP, DESK];
    held.value = { cursor: [{ id: `cur_here`, label: `Work`, email: `ADA@acme.dev`, connectedAt: 1 }] };
    await mount();
    await waitFor(() => expect(shown()).toContain(`Devin`));
    expect(shown()).not.toContain(`Work`);
    expect(shown()).not.toContain(`It is borrowed from ada-laptop`);
    expect(shown()).toContain(`Borrow turn by turn · on ada-laptop`);
    expect(shown()).toContain(`Copy its key · on ada-desk · ops@acme.dev`);
});

it(`brings every account that can come in one press, a link on each sandbox they come from, and shows what became of each`, async () => {
    sandboxes.value = [HERE, LAPTOP, DESK];
    await mount();
    await waitFor(() => expect(buttons(`Bring all`)).toHaveLength(1));
    buttons(`Bring all`)[0]?.click();

    await waitFor(() => expect(shown()).toContain(`Borrowed`));
    // A new link on the laptop lending exactly its three, and one on the desk lending its one, each card saved here.
    expect(mintAt).toHaveBeenCalledWith(LAPTOP.id, {
        label: HERE.name,
        from: { sandboxId: HERE.id, url: HERE.daemonUrl },
        terms: {
            tasks: false,
            approve: false,
            accounts: [{ provider: `claude`, account: `acc_max` }, { provider: `cursor`, account: `cur_1` }, { provider: `endpoint/openrouter` }],
        },
    });
    expect(mintAt).toHaveBeenCalledWith(DESK.id, expect.objectContaining({ terms: expect.objectContaining({ accounts: [{ provider: `devin`, account: `dev_1` }] }) }));
    expect(add).toHaveBeenCalledWith({
        id: `accounts-ada-laptop`,
        kind: `link`,
        config: { url: LAPTOP.daemonUrl, token: `ilk_secret`, name: LAPTOP.name, sandboxId: LAPTOP.id, purpose: `accounts` },
    });
    expect(borrowHere).toHaveBeenCalledTimes(2);
    expect(accountsMoved).toHaveBeenCalledTimes(1);
    expect(shown()).toContain(`Copied`);
    // The one that failed says why, in the daemon's words, and can be pressed again; the others offer no second press.
    expect(shown()).toContain(`That key has expired on ada-laptop · on ada-laptop · Cursor`);
    expect(buttons(`Bring`)).toHaveLength(1);
    expect(buttons(`Bring all`)).toHaveLength(0);
    const again = rowAround(buttons(`Bring`)[0], `Work`)?.textContent ?? ``;
    expect(again).toContain(`That key has expired on ada-laptop`);
    expect(again).not.toContain(`Claude Max`);
});

it(`names the sandboxes it could not see into, and why, rather than leaving them out`, async () => {
    sandboxes.value = [HERE, LAPTOP, DESK, ASLEEP];
    shareableAt.mockImplementation(async (id: string) => {
        throw id === LAPTOP.id ? new SandboxHttpError(404, `Not found`) : new Error(`Failed to fetch`);
    });
    try {
        await mount();
        await waitFor(() => expect(shown()).toContain(`ada-laptop runs a build too old to share accounts.`));
        expect(shown()).toContain(`Couldn't reach ada-desk, so its accounts aren't listed.`);
        expect(shown()).toContain(`ada-old isn't running.`);
        expect(buttons(`Bring`)).toHaveLength(0);
        expect(shown()).not.toContain(`already here`);
    } finally {
        shareableAt.mockImplementation(async (id: string) => (id === DESK.id ? DESK_LISTING : LISTING));
    }
});

it(`says when everything the other sandboxes hold is already here`, async () => {
    shareableAt.mockImplementationOnce(async () => ({ sandbox: `ada-laptop`, accounts: [] }));
    await mount();
    await waitFor(() => expect(shown()).toContain(`Everything your other sandboxes hold is already here.`));
});

it(`says this sandbox needs an update to bring accounts in, rather than drawing nothing`, async () => {
    borrowSupported.value = false;
    await mount();
    expect(shown()).toContain(`Update needed: Accounts your other sandboxes hold can be brought here`);
    expect(shareableAt).not.toHaveBeenCalled();
});

it(`draws nothing when the owner has no other sandbox to bring from`, async () => {
    sandboxes.value = [HERE];
    await mount();
    expect(shown()).not.toContain(`From your other sandboxes`);
});
