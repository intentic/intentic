// @vitest-environment jsdom
//
// jsdom because the subject is what reaches the SCREEN, which a projection test cannot see. The rail's data is
// pinned next door in composables/chat/chatCapacity.test.ts; what is pinned here are the two ways this column
// stops being readable at the width it has to live at:
//
//   1. a pool of thirty-one sign-ins nobody chooses between, drawn one row per gmail address, which is 31
//      restatements of one fact in a column 240px wide;
//   2. a provider that has quietly fallen off the list, so "spent until Sunday" and "never connected" render as
//      the same nothing — in a window with no shell around it, and therefore no Usage tab to go and check in.
import type { OauthAccount, TranslatorAccounts } from "@intentic/sandbox-contract";
import { afterEach, expect, it } from "vitest";
import { type App, createApp, defineComponent, h } from "vue";

// The rail's import chain pulls in app-wide singletons that read browser globals at import time (@intentic/ui's
// useDevice reads window.matchMedia; environment.ts reads window.env).
const { default: ChatCapacityRail } = await import("./ChatCapacityRail.vue");
const { accountsLoaded, providerAccounts, providerRefusals, translatorAccounts } = await import("../composables/chat/providerAccounts");
// The app's own reset formatter, not a second copy of it: what is asserted below is that the sentence CARRIES
// the reset, and a transcribed "Mon 05:00" would fail in another timezone while proving nothing about that.
const { formatReset } = await import("../composables/chat/usageStatus");

const NO_ROUTED: TranslatorAccounts = { codex: [], grok: [], kimi: [], gemini: [] };
const MEASURED_AT = Date.now() - 60_000;

const claude = (over: Partial<OauthAccount>): OauthAccount => ({ id: `acc`, label: `first@example.com`, connectedAt: 0, ...over });

let app: App | undefined;

const mount = (accounts: Partial<OauthAccount>[], routed: TranslatorAccounts = NO_ROUTED): HTMLElement => {
    providerAccounts.value = { claude: accounts.map(claude) };
    translatorAccounts.value = routed;
    accountsLoaded.value = true;
    const el = document.createElement(`div`);
    document.body.append(el);
    // Icon and v-tooltip are registered app-wide by installUi; stand-ins keep this test off the whole UI plugin.
    app = createApp({ render: () => h(ChatCapacityRail) });
    app.component(`Icon`, defineComponent({ props: { name: String }, render: () => h(`i`) }));
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    providerAccounts.value = {};
    translatorAccounts.value = NO_ROUTED;
    providerRefusals.value = {};
});

// The bars, by the width each was actually given: the one thing about this column that is drawn rather than
// written, and the one a reader compares between rows without reading a digit.
const barWidths = (el: HTMLElement): string[] =>
    [...el.querySelectorAll<HTMLElement>(`.bg-current`)].map((bar) => bar.style.width).filter((width) => width !== ``);

/* WHAT THE COLUMN DRAWS, without the sentence spoken beside it. The two are meant to carry the same facts —
 * the row is decoration and hidden from the tree, the sr-only sentence is the content — so `textContent` holds
 * every line twice by design, and counting a phrase across the whole subtree counts the medium, not the
 * repetition. Anything asking "is this said once?" is asking it of one medium at a time. */
const drawn = (el: HTMLElement): string => [...el.querySelectorAll(`[aria-hidden="true"]`)].map((node) => node.textContent ?? ``).join(` `);

const spoken = (el: HTMLElement): string[] => [...el.querySelectorAll(`.sr-only`)].map((node) => node.textContent ?? ``);

it(`draws one bar for a pool nobody picks among, and never a row per sign-in`, () => {
    const el = mount(
        [],
        {
            ...NO_ROUTED,
            gemini: [4, 44, 91, 30, 12, 7].map((percent, index) => ({
                name: `gemini-${index}`,
                label: `radarsuspam${index}@gmail.com`,
                usage: { measuredAt: MEASURED_AT, windows: [{ kind: `seven_day`, utilization: percent, gates: `all` }] },
            })),
        },
    );

    // One bar, at the pool's roomiest reading: what a turn routed to this provider would land on.
    expect(barWidths(el)).toEqual([`4%`]);
    // And not one address among them: the reader cannot pick between these, so naming one would read as
    // "this account is what you have".
    expect(el.textContent).not.toContain(`radarsuspam`);
    // The depth of the pool is what the count carries instead. Five of six: 91% is spent.
    expect(el.textContent).toContain(`5/6`);
});

/* "Most room" NAMES A COMPARISON, and a plan that publishes no limits has had none made. Two Grok connections
 * drew it directly above "no published limits" — one line contradicting the next, and both describing a reading
 * that does not exist. */
it(`does not claim a pool has the most room when nothing in it was measured`, () => {
    const el = mount([], {
        ...NO_ROUTED,
        grok: [
            { name: `grok-1`, label: `one@example.com` },
            { name: `grok-2`, label: `two@example.com` },
        ],
    });

    // In neither medium: the drawn line and the spoken sentence are built separately, so the claim has to be
    // absent from both or it is only half withdrawn.
    expect(el.textContent).not.toContain(`most room`);
    // And the one true thing exactly once on the drawn line, not once as the row's name and again as the line
    // under it, which is how it read before: "most room" over "no published limits" over "no published limits".
    expect(drawn(el).match(/no published limits/g)).toHaveLength(1);
    // The sentence a screen reader gets says it too, and says only it: with no figure there is nothing else to
    // report about this pool, and "most room of 2" would be a comparison of two unknowns.
    expect(spoken(el)).toEqual([`no published limits`]);
});

it(`names a provider that has fallen off the list, and when it comes back`, () => {
    const el = mount([
        { id: `a`, label: `spent@example.com`, usage: { measuredAt: MEASURED_AT, windows: [{ kind: `seven_day`, utilization: 96, resetsAt: 1_700_090_000, gates: `all` }] } },
    ]);

    // No offer, so no bar: an empty track over a spent account is the claim this rail exists not to make.
    expect(barWidths(el)).toEqual([]);
    expect(el.textContent).toContain(`Unavailable`);
    expect(el.textContent).toContain(`Claude Code`);
    // The absence is dated rather than merely stated: waiting is the whole of what there is to do about it.
    expect(el.querySelector(`[aria-label="Plan headroom"]`)?.textContent).toMatch(/Nothing has room right now/);
});

it(`spells out for a screen reader what the bar says by its width`, () => {
    const el = mount([
        { id: `a`, label: `first@example.com`, usage: { measuredAt: MEASURED_AT, windows: [{ kind: `seven_day`, utilization: 41, resetsAt: 1_700_090_000, gates: `all` }] } },
    ]);

    // A bar is decoration to a screen reader and a hover never reaches one, so every part the column drops —
    // which pool the figure came from, when it reopens — is spoken here or nowhere.
    expect(spoken(el)).toContain(`Weekly · all models 41% · resets ${formatReset(1_700_090_000)}`);
    // And spoken ONCE: the drawn row is hidden from the tree, or a reader hears the truncated line and then
    // the whole one.
    expect(el.querySelector(`[aria-hidden="true"] .tabular-nums`)?.textContent?.trim()).toBe(`41%`);
});
