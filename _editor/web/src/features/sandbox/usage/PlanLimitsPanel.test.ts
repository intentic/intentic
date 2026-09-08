// @vitest-environment jsdom
// needs jsdom: pins position (data itself is pinned in usageStatus.test.ts), specifically that an account
// heading sits visually above the pool meters it groups, not styled like one of them.
import type { AccountUsage, OauthAccount, TranslatorAccounts } from "@intentic/sandbox-contract";
import { afterEach, expect, it } from "vitest";
import { type App, createApp, h, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";

// Import chain touches window.matchMedia (@intentic/ui useDevice) and window.env (environment.ts) at import time.

const { default: PlanLimitsPanel } = await import("./PlanLimitsPanel.vue");
const { accountsLoaded, providerAccounts, translatorAccounts, usageByAccount } = await import("../../chat/accounts/providerAccounts");

const NO_ROUTED: TranslatorAccounts = { codex: [], grok: [], kimi: [], gemini: [] };

// Mirrors real accounts: some named by email, one still carrying the provider's default name.
const claudeAccount = (over: Partial<OauthAccount>): OauthAccount => ({
    id: `acc-1`,
    label: `first@example.com`,
    connectedAt: 0,
    usage: { measuredAt: Date.now(), windows: [{ kind: `five_hour`, utilization: 44, gates: `all` }] },
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
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

afterEach(() => {
    // Shared usage map outlives the rows that seeded it; reset so a reused id doesn't inherit a stale reading.
    usageByAccount.value = {};
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

// Found by name, not position or index, since the tiers themselves are what this file tests.
const accountLine = (el: HTMLElement, label: string): HTMLElement | undefined =>
    [...el.querySelectorAll(`span`)].find((span) => span.textContent?.trim() === label);

it(`sets an account a tier above the pools it heads, so an email cannot read as a fourth meter`, () => {
    const el = mount([claudeAccount({}), claudeAccount({ id: `acc-2`, label: `second@example.com` })]);

    const account = accountLine(el, `first@example.com`);
    const pool = accountLine(el, `5-hour session`);
    // Three-tier scale (chat.css): meta 2xs, body xs, title sm. Pools sit at meta; the heading account is a step up.
    expect(account?.className).toContain(`text-xs`);
    expect(account?.className).toContain(`text-content`);
    expect(pool?.className).toContain(`text-2xs`);
    expect(pool?.className).toContain(`text-muted`);
});

it(`names who an account signs in as when its own label does not`, () => {
    const el = mount([claudeAccount({ label: `Claude`, email: `someone@corp.example` })]);
    // A lone account's identity appears on the provider line itself, where the reader already is.
    expect(el.textContent).toContain(`Claude · someone@corp.example`);
});

it(`does not print an identity twice for an account already named by its email`, () => {
    const el = mount([claudeAccount({ label: `first@example.com`, email: `first@example.com` })]);
    expect(el.textContent?.match(/first@example\.com/g)?.length).toBe(1);
});

// the alarm, pins what this screen may shout about: an unrefreshable credential, never a merely spent pool (the
// ordinary state of a fleet, already counted in capacity).

const spent: AccountUsage = { measuredAt: Date.now(), windows: [{ kind: `five_hour`, utilization: 96, gates: `all` }] };

const alarm = (el: HTMLElement): HTMLElement | undefined =>
    [...el.querySelectorAll(`span`)].find((span) => span.textContent?.trim().startsWith(`Sign-in expired`) === true);

it(`stays silent about a fleet that is merely spent: the pools reopen on their own`, () => {
    const el = mount([1, 2, 3, 4, 5].map((n) => claudeAccount({ id: `acc-${n}`, label: `account-${n}@example.com`, usage: spent })));

    expect(alarm(el)).toBeUndefined();
    // Still counted, just not alarmed: the capacity strip already shows this.
    expect(el.textContent).toContain(`0 of 5 accounts have room`);
});

it(`states the fix once and spends the rest of the section on names`, () => {
    const el = mount([
        claudeAccount({ id: `acc-1`, label: `first@example.com`, usage: undefined, needsReauth: true }),
        claudeAccount({ id: `acc-2`, label: `second@example.com`, usage: undefined, needsReauth: true }),
        claudeAccount({ id: `acc-3`, label: `third@example.com`, usage: spent }),
    ]);

    expect(alarm(el)?.textContent?.trim()).toBe(`Sign-in expired · 2`);
    expect(el.textContent?.match(/reconnect them on the Agent tab/g)?.length).toBe(1);
    // The spent (not expired) account is excluded from the named list.
    const section = alarm(el)?.closest(`div.flex.flex-col`);
    expect(section?.textContent).toContain(`first@example.com`);
    expect(section?.textContent).not.toContain(`third@example.com`);
});

it(`caps the names rather than growing a column again, and says how many it held back`, async () => {
    // Zero-padded so label sort matches numeric order, keeping "the last three" as expected.
    const el = mount(
        Array.from({ length: 15 }, (_, index) => {
            const name = `account-${String(index).padStart(2, `0`)}@example.com`;
            return claudeAccount({ id: `acc-${index}`, label: name, usage: undefined, needsReauth: true });
        }),
    );

    expect(alarm(el)?.textContent?.trim()).toBe(`Sign-in expired · 15`);
    const more = [...el.querySelectorAll(`button`)].find((button) => /\+3 more/.test(button.textContent ?? ``));
    expect(el.textContent).not.toContain(`account-14@example.com`);

    more?.click();
    await nextTick();
    expect(el.textContent).toContain(`account-14@example.com`);
});
