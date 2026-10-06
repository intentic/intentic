// The picker's account list as a reader meets it: the row ticked is the account the next turn runs on (never the first
// one listed), the accounts that can take a turn come first, and one that can take none is dimmed with its reason
// legible. The reported bug: an org-disabled account listed first was ticked while the turn ran on another.
import "@intentic/testing/dom";
import type { AccountState, AgentProvider, OauthAccount } from "@intentic/sandbox-contract";
import { type App, computed, createApp, h } from "vue";
import { IconStub } from "@intentic/ui/testing";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";

// The provider's connected accounts, in the provider's own order, as the daemon lists them.
let listed: OauthAccount[] = [];
jest.mock("../../../client/sandbox/sandboxRpc", () => ({ sandboxRpc: fakeSandboxRpc() }));
jest.mock("./useChat-accounts", () => ({
    accountsOf: (provider: AgentProvider) => (provider === `claude` ? listed : []),
    refreshConnections: jest.fn(async () => {}),
    subscriptionOnly: () => false,
}));
// A sandbox new enough to judge its own accounts, which is every one this list is drawn for.
jest.mock("./accountsOutdated", () => ({ accountsOutdated: computed(() => false) }));
const { default: PickerAccounts } = await import("./PickerAccounts.vue");

const account = (id: string, state: AccountState): OauthAccount => ({ id, label: `${id}@example.com`, connectedAt: 0, state });
const SEATLESS: AccountState = { kind: `blocked`, fix: `admin`, reason: `Your organization has disabled Claude subscription access.` };
const SPENT: AccountState = { kind: `spent`, reopensAt: 1_900_000_000 };

let app: App | undefined;
const picks: string[] = [];
const mount = (props: { account?: string; named?: boolean } = {}): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({
        render: () =>
            h(PickerAccounts, { provider: `claude`, harness: `native`, model: `a-model`, ...props, onSelectAccount: (id: string) => picks.push(id) }),
    });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

const rows = (element: HTMLElement): HTMLElement[] => [...element.querySelectorAll<HTMLElement>(`#picker-account-list button`)];
const labelOf = (row: HTMLElement): string => row.querySelector(`.text-content`)?.textContent?.trim() ?? ``;
const ticked = (element: HTMLElement): string[] =>
    rows(element)
        .filter((row) => row.dataset[`current`] === `true`)
        .map(labelOf);

beforeEach(() => {
    listed = [account(`work`, SEATLESS), account(`personal`, { kind: `ready`, room: 40 }), account(`spare`, { kind: `ready`, room: 70 })];
    picks.length = 0;
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`ticks the account a turn naming none runs on, says the runtime picked it, and never the first one listed`, () => {
    const element = mount();

    expect(ticked(element)).toEqual([`spare@example.com`]);
    const spare = rows(element).find((row) => labelOf(row) === `spare@example.com`)!;
    expect(spare.textContent).toContain(`Auto`);
    expect(spare.className).toContain(`ui-row-select-on`);
});

it(`draws the accounts that can take a turn first, the spent ones next, the ones a person has to fix last`, () => {
    listed = [
        account(`work`, SEATLESS),
        account(`drained`, SPENT),
        account(`personal`, { kind: `ready`, room: 40 }),
        account(`unread`, { kind: `unknown` }),
    ];
    const element = mount();

    expect(rows(element).map(labelOf)).toEqual([`personal@example.com`, `unread@example.com`, `drained@example.com`, `work@example.com`]);
});

it(`dims a row that can take no turn but keeps its reason legible, and says when a spent one reopens`, () => {
    listed = [account(`work`, SEATLESS), account(`drained`, SPENT), account(`personal`, { kind: `ready`, room: 40 })];
    const element = mount();
    const row = (id: string): HTMLElement => rows(element).find((candidate) => labelOf(candidate) === `${id}@example.com`)!;

    expect(row(`work`).querySelector(`.text-content`)?.className).toContain(`opacity-50`);
    expect(row(`work`).querySelector(`.text-warning`)?.textContent).toContain(`Your organization has disabled Claude subscription access.`);
    expect(row(`work`).querySelector(`.text-warning`)?.className).not.toContain(`opacity-50`);
    expect(row(`drained`).querySelector(`.text-content`)?.className).toContain(`opacity-50`);
    expect(row(`drained`).textContent).toContain(`Allowance used up, reopens`);
    expect(row(`personal`).querySelector(`.text-content`)?.className).not.toContain(`opacity-50`);
    // Dimmed, never disabled: picking one is an attempt on it.
    row(`work`).click();
    expect(picks).toEqual([`work`]);
});

it(`ticks a pick the turn names whatever its state, as the one the turn is tried on`, () => {
    const element = mount({ account: `work` });

    expect(ticked(element)).toEqual([`work@example.com`]);
    expect(element.textContent).not.toContain(`Auto`);
});

it(`moves the tick off the conversation's own account once an organisation took its seat, as the daemon moves the turn`, () => {
    const element = mount({ account: `work`, named: false });

    expect(ticked(element)).toEqual([`spare@example.com`]);
    expect(element.textContent).toContain(`Auto`);
});

it(`ticks nothing for an account gone from the list, whose turn the daemon refuses`, () => {
    const element = mount({ account: `disconnected`, named: false });

    expect(ticked(element)).toEqual([]);
});
