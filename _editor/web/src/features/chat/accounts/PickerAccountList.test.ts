// The picker's account list as a reader meets it: the row ticked is the account the next turn runs on (never the first
// one listed), the accounts that can take a turn come first, and one that can take none is dimmed with its reason
// legible. The reported bug: an org-disabled account listed first was ticked while the turn ran on another.
import "@intentic/testing/dom";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { type App, computed, createApp, h } from "vue";
import { IconStub } from "@intentic/ui/testing";
import type { TurnPick } from "../../../models/conversations/run/turnDefaults";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";

// The provider's connected accounts, in the provider's own order, as the daemon lists them.
let listed: OauthAccount[] = [];
jest.mock("../../../client/sandbox/sandboxRpc", () => ({ sandboxRpc: fakeSandboxRpc() }));
jest.mock("../../../models/conversations/accounts/useChat-accounts", () => ({
    accountsOf: (provider: AgentProvider) => (provider === `claude` ? listed : []),
    refreshConnections: jest.fn(async () => {}),
    subscriptionOnly: () => false,
}));
// A sandbox new enough to judge its own accounts, which is every one this list is drawn for.
jest.mock("../../../models/providers/accountsOutdated", () => ({ accountsOutdated: computed(() => false) }));
const { default: PickerAccounts } = await import("./PickerAccounts.vue");
const { endpointProviders, providerModels } = await import("../../../models/providers/providerCatalog");

// An account as the daemon lists it: the facts the one rule judges (a seat mark, a reading), never a verdict.

const account = (id: string, facts: Partial<OauthAccount> = {}): OauthAccount => ({ id, label: `${id}@example.com`, connectedAt: 0, ...facts });

const room = (left: number): Partial<OauthAccount> => ({ usage: { measuredAt: Date.now(), windows: [{ kind: `seven_day`, utilization: 100 - left, gates: `all` }] } });
const SEATLESS: Partial<OauthAccount> = { seatRefusal: `Your organization has disabled Claude subscription access.` };
const SPENT: Partial<OauthAccount> = { usage: { measuredAt: Date.now(), windows: [{ kind: `seven_day`, utilization: 100, resetsAt: 1_900_000_000, gates: `all` }] } };

let app: App | undefined;
const picks: string[] = [];
const credentials: [TurnPick, string | undefined][] = [];
const mount = (props: { account?: string; named?: boolean; provider?: AgentProvider; model?: string; providerLocked?: boolean } = {}): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({
        render: () =>
            h(PickerAccounts, {
                provider: `claude`,
                harness: `native`,
                model: `a-model`,
                ...props,
                onSelectAccount: (id: string) => picks.push(id),
                onSelectCredential: (pick: TurnPick, named: string | undefined) => credentials.push([pick, named]),
            }),
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
    listed = [account(`work`, SEATLESS), account(`personal`, room(40)), account(`spare`, room(70))];
    picks.length = 0;
    credentials.length = 0;
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    endpointProviders.value = [];
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
        account(`personal`, room(40)),
        account(`unread`),
    ];
    const element = mount();

    expect(rows(element).map(labelOf)).toEqual([`personal@example.com`, `unread@example.com`, `drained@example.com`, `work@example.com`]);
});

it(`dims a row that can take no turn but keeps its reason legible, and says when a spent one reopens`, () => {
    listed = [account(`work`, SEATLESS), account(`drained`, SPENT), account(`personal`, room(40))];
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

it(`names the model's own pool when only that is spent, so the row never reads as the whole account used up`, () => {
    // The reported case: Fable's weekly slice at 100% while the weekly allowance for every model still had 16% left.
    const sliceSpent: Partial<OauthAccount> = {
        usage: {
            measuredAt: Date.now(),
            windows: [
                { kind: `seven_day`, utilization: 84, resetsAt: 1_900_000_000, gates: `all` },
                { kind: `model:Fable`, label: `Fable`, utilization: 100, resetsAt: 1_900_000_000, gates: { models: [`Fable`] } },
            ],
        },
    };
    listed = [account(`fable`, sliceSpent), account(`drained`, SPENT), account(`personal`, room(40))];
    const element = mount({ model: `claude-fable-5-2` });
    const row = (id: string): HTMLElement => rows(element).find((candidate) => labelOf(candidate) === `${id}@example.com`)!;

    expect(row(`fable`).textContent).toContain(`Fable allowance used up, reopens`);
    // An allowance every model spends is still the account's own.
    expect(row(`drained`).textContent).toContain(`Allowance used up, reopens`);
    expect(row(`drained`).textContent).not.toContain(`Fable`);
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

// A vendor's API key filed under the provider is picked as an account is (the owner, 2026-11-05): a row after the
// accounts, saying who bills it. To the daemon it is a provider of its own, so a pick between the two is a provider
// switch onto the same model, under the id the other one lists it by.
describe(`an API key beside the accounts`, () => {
    const KEY = `endpoint/anthropic`;
    beforeEach(() => {
        endpointProviders.value = [{ id: KEY, label: `anthropic`, kind: `endpoint`, beside: `claude` }];
        providerModels.value = {
            ...providerModels.value,
            claude: [{ value: `claude-opus-5`, label: `Claude Opus 5` }],
            [KEY]: [
                { value: `claude-opus-5-20260201`, label: `Claude Opus 5` },
                { value: `claude-sonnet-5-20260201`, label: `Claude Sonnet 5` },
            ],
        };
    });

    it(`lists the key after the accounts with who bills it, and picks it as a switch onto the same model`, () => {
        listed = [account(`personal`, room(40))];
        const element = mount({ model: `claude-opus-5` });

        expect(rows(element).map(labelOf)).toEqual([`personal@example.com`, `API key`]);
        expect(rows(element)[1]?.textContent).toContain(`Billed per token by Anthropic`);
        rows(element)[1]!.click();
        expect(credentials).toEqual([[{ provider: KEY, value: `claude-opus-5-20260201` }, undefined]]);
    });

    it(`on the key, ticks the key and picks an account as the sign-in it belongs to, named`, () => {
        listed = [account(`personal`, room(40)), account(`spare`, room(70))];
        const element = mount({ provider: KEY, model: `claude-opus-5-20260201` });

        expect(ticked(element)).toEqual([`API key`]);
        rows(element).find((row) => labelOf(row) === `spare@example.com`)!.click();
        expect(credentials).toEqual([[{ provider: `claude`, value: `claude-opus-5` }, `spare`]]);
        expect(picks).toEqual([]);
    });

    it(`holds a switch between the key and an account while a turn runs, as any provider switch waits`, () => {
        listed = [account(`personal`, room(40))];
        const element = mount({ providerLocked: true });

        expect(rows(element).find((row) => labelOf(row) === `API key`)?.hasAttribute(`disabled`)).toBe(true);
        expect(rows(element).find((row) => labelOf(row) === `personal@example.com`)?.hasAttribute(`disabled`)).toBe(false);
    });
});
