// @vitest-environment jsdom
//
// jsdom because both subjects are POSITION, where a fact is drawn, which is the one thing a projection test
// cannot see. The panel's data is pinned next door in usageStatus.test.ts; what is pinned here is the way
// account headings sit above the pool meters they head:
//
//   an account was set exactly like the pool labels underneath it, so a provider holding three accounts drew
//   nine meters in one column with nothing to say which three belonged to which sign-in.
import type { OauthAccount, TranslatorAccounts } from "@intentic/sandbox-contract";
import { afterEach, expect, it } from "vitest";
import { type App, createApp, defineComponent, h, nextTick } from "vue";

// The panel's import chain pulls in app-wide singletons that read browser globals at import time (@intentic/ui's
// useDevice reads window.matchMedia; environment.ts reads window.env).

const { default: PlanLimitsPanel } = await import("./PlanLimitsPanel.vue");
const { accountsLoaded, providerAccounts, translatorAccounts } = await import("../../composables/chat/providerAccounts");

const NO_ROUTED: TranslatorAccounts = { codex: [], grok: [], kimi: [], gemini: [] };

// Three Claude accounts, as this sandbox actually holds them: two named by their own email, one still carrying
// the provider's default name with an email behind it: the row that identifies nothing on name alone.
const claudeAccount = (over: Partial<OauthAccount>): OauthAccount => ({
    id: `acc-1`,
    label: `first@example.com`,
    connectedAt: 0,
    usage: { measuredAt: Date.now(), windows: [{ kind: `five_hour`, utilization: 44 }] },
    ...over,
});

let app: App | undefined;

const mount = (accounts: OauthAccount[]): HTMLElement => {
    providerAccounts.value = { claude: accounts };
    translatorAccounts.value = NO_ROUTED;
    accountsLoaded.value = true;
    const el = document.createElement(`div`);
    document.body.append(el);
    // Icon and v-tooltip are registered app-wide by installUi; stand-ins keep this off the whole UI plugin.
    app = createApp({ render: () => h(PlanLimitsPanel) });
    app.component(`Icon`, defineComponent({ props: { name: String }, render: () => h(`i`) }));
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

// The account's own line, found by the name printed on it rather than by position: the tiers are what this
// file is about, so reading them off a fixed index would assume the answer.
const accountLine = (el: HTMLElement, label: string): HTMLElement | undefined =>
    [...el.querySelectorAll(`span`)].find((span) => span.textContent?.trim() === label);

it(`sets an account a tier above the pools it heads, so an email cannot read as a fourth meter`, () => {
    const el = mount([claudeAccount({}), claudeAccount({ id: `acc-2`, label: `second@example.com` })]);

    const account = accountLine(el, `first@example.com`);
    const pool = accountLine(el, `5-hour session`);
    // The app's three-tier scale (chat.css): meta 2xs, body xs, title sm. The pools sit at meta; the account
    // that heads them has to be a step up, in the reading colour rather than the muted one.
    expect(account?.className).toContain(`text-xs`);
    expect(account?.className).toContain(`text-content`);
    expect(pool?.className).toContain(`text-2xs`);
    expect(pool?.className).toContain(`text-muted`);
});

it(`names who an account signs in as when its own label does not`, () => {
    const el = mount([claudeAccount({ label: `Claude`, email: `someone@corp.example` })]);
    // A lone account rides the provider line, which is where its identity has to appear too: the roster is a
    // click away and the reader is looking at this row.
    expect(el.textContent).toContain(`Claude · someone@corp.example`);
});

it(`does not print an identity twice for an account already named by its email`, () => {
    const el = mount([claudeAccount({ label: `first@example.com`, email: `first@example.com` })]);
    expect(el.textContent?.match(/first@example\.com/g)?.length).toBe(1);
});

/* ---- the alarm ------------------------------------------------------------------------------------------------
 * The third subject: WHAT THIS SCREEN IS ALLOWED TO SHOUT ABOUT. It used to raise a spent pool, which is the most
 * ordinary event on a fleet, so at the end of a week a 36-account sandbox drew a 32-line alarm saying, one
 * account at a time, exactly what the capacity strip above it says in one sentence. An alarm that is longest when
 * nothing is wrong is one its reader learns to scroll past, taking the dead credential in it along. */

const spent = { measuredAt: Date.now(), windows: [{ kind: `five_hour`, utilization: 96 }] };

const alarm = (el: HTMLElement): HTMLElement | undefined =>
    [...el.querySelectorAll(`span`)].find((span) => span.textContent?.trim().startsWith(`Sign-in expired`) === true);

it(`stays silent about a fleet that is merely spent: the pools reopen on their own`, () => {
    const el = mount([1, 2, 3, 4, 5].map((n) => claudeAccount({ id: `acc-${n}`, label: `account-${n}@example.com`, usage: spent })));

    expect(alarm(el)).toBeUndefined();
    // Not lost, just not shouted: the capacity strip still counts every one of them and dates the reopen.
    expect(el.textContent).toContain(`0 of 5 accounts have room`);
});

it(`states the fix once and spends the rest of the section on names`, () => {
    const el = mount([
        claudeAccount({ id: `acc-1`, label: `first@example.com`, usage: undefined, needsReauth: true }),
        claudeAccount({ id: `acc-2`, label: `second@example.com`, usage: undefined, needsReauth: true }),
        claudeAccount({ id: `acc-3`, label: `third@example.com`, usage: spent }),
    ]);

    expect(alarm(el)?.textContent?.trim()).toBe(`Sign-in expired · 2`);
    // Once: the old section repeated this eleven-word instruction on every row it drew.
    expect(el.textContent?.match(/reconnect them on the Agent tab/g)?.length).toBe(1);
    // And the spent account is not among the named, however full its pool is.
    const section = alarm(el)?.closest(`div.flex.flex-col`);
    expect(section?.textContent).toContain(`first@example.com`);
    expect(section?.textContent).not.toContain(`third@example.com`);
});

it(`caps the names rather than growing a column again, and says how many it held back`, async () => {
    // Zero-padded: unread rows sort by label, so this makes "the last three" the same three a reader would name.
    const el = mount(
        Array.from({ length: 15 }, (_, index) => {
            const name = `account-${String(index).padStart(2, `0`)}@example.com`;
            return claudeAccount({ id: `acc-${index}`, label: name, usage: undefined, needsReauth: true });
        }),
    );

    expect(alarm(el)?.textContent?.trim()).toBe(`Sign-in expired · 15`);
    const more = [...el.querySelectorAll(`button`)].find((button) => /\+3 more/.test(button.textContent ?? ``));
    expect(el.textContent).not.toContain(`account-14@example.com`);

    // A cap, not a ceiling: the rest are one click away, in place.
    more?.click();
    await nextTick();
    expect(el.textContent).toContain(`account-14@example.com`);
});
