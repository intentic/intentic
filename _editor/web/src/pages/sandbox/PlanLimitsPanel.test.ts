// @vitest-environment jsdom
//
// jsdom because both subjects are POSITION, where a fact is drawn, which is the one thing a projection test
// cannot see. The panel's data is pinned next door in usageStatus.test.ts; what is pinned here is the two ways
// that data was being mis-placed on screen:
//
//   1. an account was set exactly like the pool labels underneath it, so a provider holding three accounts drew
//      nine meters in one column with nothing to say which three belonged to which sign-in;
//   2. a refusal the daemon had attributed to ONE account was drawn over the provider heading all of them:
//      "Claude Code refused its credential" above three accounts, two of which had never refused anything.
import type { OauthAccount, TranslatorAccounts } from "@intentic/sandbox-contract";
import { afterEach, expect, it } from "vitest";
import { type App, createApp, defineComponent, h, nextTick } from "vue";

// The panel's import chain pulls in app-wide singletons that read browser globals at import time (@intentic/ui's
// useDevice reads window.matchMedia; environment.ts reads window.env).

const { default: PlanLimitsPanel } = await import("./PlanLimitsPanel.vue");
const { accountsLoaded, providerAccounts, providerRefusals, translatorAccounts } = await import("../../composables/chat/providerAccounts");

const NO_ROUTED: TranslatorAccounts = { codex: [], grok: [], kimi: [], gemini: [] };
const HOUR = 3_600_000;

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
    providerRefusals.value = {};
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

/* The refusal, and the reason this test file exists. The daemon records the account a native turn was serving;
 * drawing that on the provider line accuses every account under it. */
it(`draws a refusal under the account it names, not over the provider heading all of them`, async () => {
    providerRefusals.value = {
        claude: { at: Date.now() - 3 * HOUR, kind: `auth`, message: `401 OAuth access token has been revoked.`, account: `acc-2` },
    };
    const el = mount([claudeAccount({}), claudeAccount({ id: `acc-2`, label: `second@example.com` })]);

    const refusal = [...el.querySelectorAll(`p`)].find((line) => /Refused its credential/.test(line.textContent ?? ``));
    expect(refusal).toBeDefined();
    // Inside its own account's block, and that block is the refused one, not a sibling, and not the group.
    const block = refusal?.closest(`div.flex.flex-col`);
    expect(block?.textContent).toContain(`second@example.com`);
    expect(block?.textContent).not.toContain(`first@example.com`);
});

// Past three accounts the panel folds the list into a strip of bars, so there is no per-account block to hang
// the line on. It stays at group level there, but says whose refusal it is, because "one of these 24 refused"
// is not an answer to "which one do I go and fix".
it(`names the account in the line when the group is folded and has no block to draw it in`, () => {
    providerRefusals.value = {
        claude: { at: Date.now() - 3 * HOUR, kind: `limit`, message: `usage limit reached`, account: `acc-3` },
    };
    const el = mount(
        [1, 2, 3, 4].map((n) =>
            claudeAccount({
                id: `acc-${n}`,
                label: `account-${n}@example.com`,
                // The refused one is still spent, so nothing has answered it and it is drawn as the live fact
                // it is: the pairing a limit refusal actually appears in.
                ...(n === 3 ? { usage: { measuredAt: Date.now(), windows: [{ kind: `five_hour`, utilization: 96 }] } } : {}),
            }),
        ),
    );

    const refusal = [...el.querySelectorAll(`p`)].find((line) => /Hit its usage limit/.test(line.textContent ?? ``));
    expect(refusal?.textContent?.trim()).toBe(`account-3@example.com · Hit its usage limit 3h ago, usage limit reached`);
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
    expect(more).toBeDefined();
    expect(el.textContent).not.toContain(`account-14@example.com`);

    // A cap, not a ceiling: the rest are one click away, in place.
    more?.click();
    await nextTick();
    expect(el.textContent).toContain(`account-14@example.com`);
});

it(`reads a healed refusal as history: a footnote about the account, not an alarm over the provider`, () => {
    // Refused three hours ago, and the same account has been read since without a reauth flag: the credential
    // provably works, which is the state the daemon's own token re-mint leaves behind.
    providerRefusals.value = {
        claude: { at: Date.now() - 3 * HOUR, kind: `auth`, message: `401 OAuth access token has been revoked.`, account: `acc-1` },
    };
    const el = mount([claudeAccount({}), claudeAccount({ id: `acc-2`, label: `second@example.com` })]);

    const refusal = [...el.querySelectorAll(`p`)].find((line) => /Refused its credential/.test(line.textContent ?? ``));
    expect(refusal?.textContent?.trim()).toBe(`Refused its credential 3h ago, has authenticated fine since.`);
    // Quiet, not shouted: the warning tone is reserved for a refusal that still describes the situation.
    expect(refusal?.className).toContain(`text-subtle`);
    expect(refusal?.className).not.toContain(`text-warning`);
});
