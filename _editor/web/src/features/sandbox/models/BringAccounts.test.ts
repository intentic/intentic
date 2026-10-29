// Sandbox ▸ Models' "From your other sandboxes": the owner picks another of their sandboxes, reads how each of its
// accounts would come here, brings one or all of them in, or signs in here instead. The far and near calls are the
// fakes below; the press's own order of them is shareAccounts.test.ts's to check.
import "@intentic/testing/dom";
import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import type { AccountsBorrow, AccountsBorrowed, ShareableAccounts } from "@intentic/sandbox-contract/schemas/providers/account-sharing";
import { waitFor } from "@intentic/testing/bun";
import { IconStub } from "@intentic/ui/testing";
import PrimeVue from "primevue/config";
import { type App, computed, createApp, h, nextTick, ref } from "vue";
import { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";

const HERE = { id: `sbx-shop`, name: `acme-shop`, daemonUrl: `https://shop.example`, role: `owner` };
const LAPTOP = { id: `sbx-laptop`, name: `ada-laptop`, daemonUrl: `https://laptop.example`, role: `owner` };
const sandboxes = ref([HERE, LAPTOP, { id: `sbx-guest`, name: `friend`, daemonUrl: `https://friend.example`, role: `guest` }]);
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

const capabilities = ref<CapabilitySummary[]>([]);
const add = jest.fn(async () => undefined);
const refetch = jest.fn(async () => ({ data: { capabilities: capabilities.value, recommendations: [] } }));
jest.mock(`../../../models/capabilities/useCapabilities`, () => ({ useCapabilities: () => ({ capabilities, add, refetch }) }));

const LISTING: ShareableAccounts = {
    sandbox: `ada-laptop`,
    accounts: [
        { provider: `claude`, account: `acc_max`, label: `Claude Max`, email: `ada@acme.dev`, mode: `lend` },
        { provider: `cursor`, account: `cur_1`, label: `Work`, email: `ada@acme.dev`, mode: `copy` },
        { provider: `endpoint/openrouter`, label: `openrouter`, mode: `copy` },
        { provider: `codex`, label: `ChatGPT`, email: `ada@acme.dev`, mode: `no`, reason: `Subscriptions stay on the sandbox that holds them for now.` },
    ],
};
const shareableAt = jest.fn(async (_id: string): Promise<ShareableAccounts> => LISTING);
const borrowHere = jest.fn(
    async (ask: AccountsBorrow): Promise<AccountsBorrowed> => ({
        results: ask.items.map((item) =>
            item.provider === `cursor`
                ? { ...item, outcome: `failed` as const, message: `That key has expired on ada-laptop.` }
                : { ...item, outcome: item.provider === `claude` ? (`borrowed` as const) : (`copied` as const), id: `here-1` },
        ),
    }),
);
const mintAt = jest.fn(async () => ({ id: `lnk_new`, token: `ilk_secret` }));
const accountsMoved = jest.fn(async () => undefined);
jest.mock(`./useAccountSharing`, () => ({
    shareableAt,
    borrowHere,
    accountsMoved,
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
// The picker's panel closes on a trigger with no size, which is every element jsdom lays out: given a browser's.
const pick = async (name: string): Promise<void> => {
    const trigger = document.body.querySelector<HTMLButtonElement>(`button[aria-haspopup="listbox"]`);
    if (trigger !== null) {
        trigger.getBoundingClientRect = () => new DOMRect(0, 0, 224, 32);
        trigger.click();
    }
    await settle();
    [...document.body.querySelectorAll<HTMLElement>(`[role="option"]`)].find((row) => row.textContent?.includes(name) === true)?.click();
    await settle();
};
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
    for (const fake of [add, refetch, shareableAt, borrowHere, mintAt, accountsMoved]) {
        fake.mockClear();
    }
    forgetOperations();
});

it(`offers only the owner's other sandboxes it may make a link on, and reads nothing until one is picked`, async () => {
    await mount();
    expect(shown()).toContain(`From your other sandboxes`);
    expect(shareableAt).not.toHaveBeenCalled();
    const trigger = document.body.querySelector<HTMLButtonElement>(`button[aria-haspopup="listbox"]`);
    trigger!.getBoundingClientRect = () => new DOMRect(0, 0, 224, 32);
    trigger!.click();
    await settle();
    const options = [...document.body.querySelectorAll(`[role="option"]`)].map((row) => row.textContent?.trim());
    expect(options).toEqual([`ada-laptop`]);
});

it(`says how each account would come here, and offers Bring for those that can and signing in here where this page can`, async () => {
    await mount();
    await pick(`ada-laptop`);
    expect(shareableAt).toHaveBeenCalledWith(LAPTOP.id);
    await waitFor(() => expect(shown()).toContain(`Claude Max`));
    // The way each comes first on its line, then whose it is: the provider where the label does not already say it.
    expect(shown()).toContain(`Borrow turn by turn · ada@acme.dev`);
    expect(shown()).toContain(`Copy its key · Cursor · ada@acme.dev`);
    expect(shown()).toContain(`Copy its key · Model endpoint`);
    expect(shown()).toContain(`Subscriptions stay on the sandbox that holds them for now · ada@acme.dev`);
    // Claude, Cursor and the endpoint can come; ChatGPT cannot. An endpoint has no sign-in of its own on this page.
    expect(buttons(`Bring`)).toHaveLength(3);
    expect(buttons(`Sign in here instead`)).toHaveLength(3);
    expect(buttons(`Bring all`)).toHaveLength(1);

    buttons(`Sign in here instead`).at(-1)?.click();
    expect(signIns).toEqual([`codex`]);
});

it(`brings every account that can come in one press, and shows what became of each`, async () => {
    await mount();
    await pick(`ada-laptop`);
    await waitFor(() => expect(buttons(`Bring all`)).toHaveLength(1));
    buttons(`Bring all`)[0]?.click();

    await waitFor(() => expect(shown()).toContain(`Borrowed`));
    // A new link over there lending exactly those three, its card saved here, then this sandbox asked to bring them in.
    expect(mintAt).toHaveBeenCalledWith(LAPTOP.id, {
        label: HERE.name,
        from: { sandboxId: HERE.id, url: HERE.daemonUrl },
        terms: {
            tasks: false,
            approve: false,
            accounts: [{ provider: `claude`, account: `acc_max` }, { provider: `cursor`, account: `cur_1` }, { provider: `endpoint/openrouter` }],
        },
    });
    expect(add).toHaveBeenCalledWith({
        id: `accounts-ada-laptop`,
        kind: `link`,
        config: { url: LAPTOP.daemonUrl, token: `ilk_secret`, name: LAPTOP.name, sandboxId: LAPTOP.id, purpose: `accounts` },
    });
    expect(borrowHere).toHaveBeenCalledTimes(1);
    expect(accountsMoved).toHaveBeenCalledTimes(1);
    expect(shown()).toContain(`Copied`);
    // The one that failed says why, in the daemon's words, and can be pressed again; the others offer no second press.
    expect(shown()).toContain(`That key has expired on ada-laptop · Cursor`);
    expect(buttons(`Bring`)).toHaveLength(1);
    expect(buttons(`Bring all`)).toHaveLength(0);
    const again = rowAround(buttons(`Bring`)[0], `Work`)?.textContent ?? ``;
    expect(again).toContain(`That key has expired on ada-laptop`);
    expect(again).not.toContain(`Claude Max`);
});

it(`says a source too old to share its accounts is too old, rather than that it failed`, async () => {
    shareableAt.mockImplementationOnce(async () => {
        throw new SandboxHttpError(404, `Not found`);
    });
    await mount();
    await pick(`ada-laptop`);
    await waitFor(() => expect(shown()).toContain(`ada-laptop runs a sandbox too old to share its accounts.`));
    expect(buttons(`Bring`)).toHaveLength(0);
});

it(`draws nothing when the owner has no other sandbox to bring from`, async () => {
    const all = sandboxes.value;
    sandboxes.value = [HERE];
    try {
        await mount();
        expect(shown()).not.toContain(`From your other sandboxes`);
    } finally {
        sandboxes.value = all;
    }
});
