// @vitest-environment jsdom
//
/* THE MODEL PICKER, MOUNTED, and specifically the job it took over from a card.
 *
 * A brand-new user used to meet a "Try free with Google" pitch on the first screen after signing up, headline
 * and button, with the paid subscriptions demoted under it. It read as a sign-in wall, and it was one: the
 * screen behind it could not be reached until the card was answered or the free trial arrived. The card is gone.
 * What replaced it is this panel, because this is where a person is when they want a different model, and the
 * whole offer here is made of things the list was already saying: an order, a badge, and a way out.
 *
 * So three things are pinned, and each is the card's job in its new home:
 *   · the cheapest way in LEADS the locked rows, rather than sitting last of five by alphabet
 *   · each locked row still states its price, so "free" is legible without connecting anything
 *   · the door to the accounts page is here, since nothing else offers it any more
 */
import { TRIAL_PROVIDER } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick } from "vue";

// The catalogs are daemon-owned; the picker refreshes them on open. Mocked to no-ops so the mount is about what
// the panel RENDERS from the module state each test seeds, not about a fetch.
vi.mock(`../composables/chat/useChat`, () => ({
    loadAllProviderModels: () => Promise.resolve(),
    loadProviderModels: () => Promise.resolve(),
    refreshConnections: () => Promise.resolve(),
}));
// The runtime-health probe is the daemon's; silent here, which is its own "not probed yet" state.
vi.mock(`../composables/sandbox/useSandboxVersion`, () => ({ useSandboxVersion: () => ({ runtimeIssue: () => undefined }) }));
vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    useRouter: () => ({ push: vi.fn() }) as never,
    RouterLink: (await import(`../testing/routerLinkStub`)).RouterLinkStub as never,
}));

const { providerAccounts, translatorAccounts } = await import("../composables/chat/providerAccounts");
const { acpProviders, endpointProviders, perProvider, providerModels, trialStatus } = await import("../composables/chat/providerCatalog");
const { default: ModelPicker } = await import("./ModelPicker.vue");

let app: App | undefined;
const mount = (): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ModelPicker, { provider: `claude`, model: `claude-opus-4-6` }) });
    app.component(
        `Icon`,
        defineComponent({
            props: { name: { type: String, default: `` }, spin: Boolean },
            setup: (props) => () => h(`i`, { "data-icon": props.name }),
        }),
    );
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

// The provider names, in the order their sections are drawn: the panel's own answer to "what should I look at
// first". Read off the header's first span, since the header also carries the price chip and the connect link.
const headings = (element: HTMLElement): string[] =>
    [...element.querySelectorAll(`[role="presentation"] > span:first-child`)].map((node) => node.textContent?.trim() ?? ``);

const oneModel = (label: string) => [{ value: label.toLowerCase().replaceAll(` `, `-`), label }];

beforeEach(() => {
    // Nothing connected, and every provider carrying the seed floor the daemon serves: the exact state a user
    // is in when they open this panel for the first time, and the state the old card used to cover up.
    providerAccounts.value = perProvider(() => []);
    translatorAccounts.value = { codex: [], grok: [], kimi: [], gemini: [] };
    acpProviders.value = [];
    endpointProviders.value = [];
    trialStatus.value = { available: false, allowance: 0, used: 0, remaining: 0, health: `unknown` };
    providerModels.value = {
        ...perProvider(() => []),
        claude: oneModel(`Claude Opus 4 6`),
        codex: oneModel(`GPT 5 6`),
        grok: oneModel(`Grok 4`),
        kimi: oneModel(`Kimi K3`),
        gemini: oneModel(`Gemini 3 Pro`),
    };
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`keeps the provider filters from adding a second vertical scroller beside the catalog`, () => {
    const element = mount();
    const rail = element.querySelector<HTMLElement>(`[role="radiogroup"]`)!;
    const list = element.querySelector<HTMLElement>(`#model-picker-list`)!;

    expect(rail.classList).toContain(`overflow-x-auto`);
    expect(rail.classList).not.toContain(`overflow-y-auto`);
    expect([...rail.querySelectorAll(`button`)].every((button) => button.classList.contains(`ui-row-select-horizontal`))).toBe(true);
    expect(list.classList).toContain(`overflow-y-auto`);
});

it(`leads the locked rows with the way in that costs nothing, and prices the rest`, () => {
    const element = mount();

    // Claude is the selected provider, so it leads whatever it costs: it is what the composer would send on.
    // Behind it, the free Google sign-in ahead of every paid subscription, where it used to come last.
    expect(headings(element).slice(0, 2)).toEqual([`Claude Code`, `Google`]);

    // And the price is on the row, so "free" is readable without connecting anything to find out.
    expect(element.textContent).toContain(`Free · Google sign-in`);
    expect(element.textContent).toContain(`Needs ChatGPT subscription`);
    // The pitch this panel replaced, in the words a new user actually read.
    expect(element.textContent).not.toContain(`Try free with Google`);
});

// The trial is what a fresh sandbox on the hosted platform actually sends with, so it is a working row with a
// count on it rather than a price: connected providers lead, and cost only ever separates the locked ones.
it(`seats the working free trial above the locked rows, with its allowance rather than a price`, async () => {
    endpointProviders.value = [{ id: TRIAL_PROVIDER, label: `Free trial`, kind: `endpoint` }];
    trialStatus.value = { available: true, allowance: 12, used: 0, remaining: 12, health: `healthy` };
    providerModels.value = { ...providerModels.value, [TRIAL_PROVIDER]: oneModel(`Free trial`) };
    const element = mount();
    await nextTick();

    expect(headings(element).slice(0, 3)).toEqual([`Claude Code`, `Free trial`, `Google`]);
    expect(element.textContent).toContain(String(trialStatus.value.remaining));
    expect(element.textContent).toContain(`trial`);
});

/* THE DOOR TO EVERYTHING THIS LIST CAN ONLY BADGE: a second account on one provider, an account to drop, the
 * mechanics behind a sign-in. It came off the deleted card, which was the only other place that offered it, so
 * losing it here would have left the app with no route to the accounts page from the chat at all. */
it(`carries the way out to the accounts page, and drops it while searching`, async () => {
    const element = mount();

    const door = [...element.querySelectorAll(`a`)].find((link) => link.textContent?.includes(`All AI accounts`));
    expect(door?.getAttribute(`href`)).toBe(`/sandbox/agent`);

    // Searching turns the panel into one flat result set, where a standing footer reads as a result.
    const search = element.querySelector(`input`)!;
    search.value = `opus`;
    search.dispatchEvent(new Event(`input`));
    await nextTick();
    expect(element.textContent).not.toContain(`All AI accounts`);
});
