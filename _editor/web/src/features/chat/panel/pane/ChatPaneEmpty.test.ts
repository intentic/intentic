// An empty chat's opening words, and the quiet offer off the trial that only a trial-only sandbox is shown.
import "@intentic/testing/dom";
import { type App, createApp, h, nextTick } from "vue";
import * as vueRouterOriginal from "vue-router";
import { RouterLinkStub } from "../../../../testing/routerLinkStub";

jest.mock(`vue-router`, () => ({
    ...vueRouterOriginal,
    RouterLink: RouterLinkStub as never,
}));

const { endpointProviders, endpointsLoaded, trialStatus } = await import("../../accounts/providerCatalog");
const { accountsLoaded, providerAccounts } = await import("../../accounts/providerAccounts");
const { default: ChatPaneEmpty } = await import("./ChatPaneEmpty.vue");
const noAccounts = providerAccounts.value;

type Props = { unset: boolean; onTrial: boolean; providerName: string };
const TRIAL: Props = { unset: false, onTrial: true, providerName: `Free trial` };

let app: App | undefined;
const mount = (props: Props): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatPaneEmpty, props) });
    app.mount(element);
    return element;
};

const offerLink = (element: HTMLElement): HTMLAnchorElement | undefined =>
    [...element.querySelectorAll(`a`)].find((link) => link.textContent?.includes(`lift the daily cap`));

beforeEach(() => {
    accountsLoaded.value = true;
    endpointsLoaded.value = true;
    trialStatus.value = { available: true, allowance: 10, used: 1, remaining: 9, health: `healthy` };
    endpointProviders.value = [];
    providerAccounts.value = noAccounts;
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`opens a trial chat on what it costs, and offers the way off the cap under it`, () => {
    const element = mount(TRIAL);

    expect(element.textContent).toContain(`this chat is free and needs nothing connected`);
    expect(element.textContent).toContain(`Already pay for an AI plan, or run a model on this machine?`);
    expect(offerLink(element)?.getAttribute(`href`)).toBe(`/connect`);
});

it(`names the provider a non-trial chat runs on, and offers nothing`, () => {
    const element = mount({ unset: false, onTrial: false, providerName: `Claude` });

    expect(element.textContent).toContain(`Start a conversation with Claude.`);
    expect(offerLink(element)).toBeUndefined();
});

it(`says nothing about the cap until both reads have landed`, async () => {
    endpointsLoaded.value = false;
    const element = mount(TRIAL);
    expect(offerLink(element)).toBeUndefined();

    endpointsLoaded.value = true;
    await nextTick();
    expect(offerLink(element)?.getAttribute(`href`)).toBe(`/connect`);
});

it(`leaves the offer to the trial strip once half the allowance is gone`, () => {
    trialStatus.value = { available: true, allowance: 10, used: 6, remaining: 4, health: `healthy` };

    expect(offerLink(mount(TRIAL))).toBeUndefined();
});

it(`offers nothing to a sandbox with a model on this machine`, () => {
    endpointProviders.value = [{ id: `endpoint/box`, label: `Qwen`, kind: `localmodel` }];

    expect(offerLink(mount(TRIAL))).toBeUndefined();
});

it(`offers nothing to a sandbox with a subscription connected`, () => {
    providerAccounts.value = { ...noAccounts, claude: [{ id: `acct`, label: `me@example.com` }] } as never;

    expect(offerLink(mount(TRIAL))).toBeUndefined();
});
