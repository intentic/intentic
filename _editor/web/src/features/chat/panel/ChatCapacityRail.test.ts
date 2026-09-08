// @vitest-environment jsdom
// jsdom: the subject is what reaches the screen; data is pinned in chatCapacity.test.ts. This covers two ways the
// column stops being readable at its width:
//
// 1. a pool of many sign-ins nobody chooses between, drawn one row per account, restating one fact across a
//    column too narrow for it
// 2. a provider that has fallen off the list, so "spent" and "never connected" render as the same nothing, with
//    no Usage tab in this window to check
import type { OauthAccount, TranslatorAccounts } from "@intentic/sandbox-contract";
import { afterEach, expect, it } from "vitest";
import { type App, createApp, h } from "vue";
import { IconStub } from "@intentic/ui/testing";

// Import chain pulls in app-wide singletons reading browser globals at import time (matchMedia, window.env).
const { default: ChatCapacityRail } = await import("./ChatCapacityRail.vue");
const { accountsLoaded, providerAccounts, providerRefusals, translatorAccounts } = await import("../accounts/providerAccounts");
// The app's own reset formatter, not a copy: assertions check it carries the reset, not a fixed timezone string.
const { formatReset } = await import("../session/usageStatus");

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
    app.component(`Icon`, IconStub);
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

// The bars, by the width each was given, the one part of this column drawn rather than written.
const barWidths = (el: HTMLElement): string[] =>
    [...el.querySelectorAll<HTMLElement>(`.bg-current`)].map((bar) => bar.style.width).filter((width) => width !== ``);

// Reads only the drawn (aria-hidden) row, not the sr-only sentence beside it: `textContent` holds every fact
// twice by design, so counting across the whole subtree would count the medium, not a repetition.
const drawn = (el: HTMLElement): string => [...el.querySelectorAll(`[aria-hidden="true"]`)].map((node) => node.textContent ?? ``).join(` `);

const spoken = (el: HTMLElement): string[] => [...el.querySelectorAll(`.sr-only`)].map((node) => node.textContent ?? ``);

// The name each bar is drawn under: the window length it measures, fitting two bars per account.
const lanes = (el: HTMLElement): string[] => [...el.querySelectorAll(`.text-3xs`)].map((node) => node.textContent?.trim() ?? ``);

it(`draws one bar for a pool nobody picks among, and never a row per sign-in`, () => {
    const el = mount(
        [],
        {
            ...NO_ROUTED,
            gemini: [4, 44, 100, 30, 12, 7].map((percent, index) => ({
                name: `gemini-${index}`,
                label: `radarsuspam${index}@gmail.com`,
                usage: { measuredAt: MEASURED_AT, windows: [{ kind: `seven_day`, utilization: percent, gates: `all` }] },
            })),
        },
    );

    // One bar, at the pool's roomiest reading: what a turn routed to this provider would land on.
    expect(barWidths(el)).toEqual([`4%`]);
    // Not one address shown: the reader can't pick among these, so naming one would read as the account in use.
    expect(el.textContent).not.toContain(`radarsuspam`);
    // The pool's depth is carried by the count instead; 5/6 means one credential is exhausted (spentOutright).
    expect(el.textContent).toContain(`5/6`);
});

// "Most room" names a comparison; a plan that publishes no limits has had none made, so it must not appear beside
// "no published limits".
it(`does not claim a pool has the most room when nothing in it was measured`, () => {
    const el = mount([], {
        ...NO_ROUTED,
        grok: [
            { name: `grok-1`, label: `one@example.com` },
            { name: `grok-2`, label: `two@example.com` },
        ],
    });

    // Absent from both media: the drawn line and the spoken sentence are built separately.
    expect(el.textContent).not.toContain(`most room`);
    // The one true fact appears once on the drawn line, not once as the row's name and again below it.
    expect(drawn(el).match(/no published limits/g)).toHaveLength(1);
    // The screen-reader sentence says only that: with no figure there's nothing else to report.
    expect(spoken(el)).toEqual([`no published limits`]);
});

it(`names a provider that has fallen off the list, and when it comes back`, () => {
    const el = mount([
        { id: `a`, label: `spent@example.com`, usage: { measuredAt: MEASURED_AT, windows: [{ kind: `seven_day`, utilization: 100, resetsAt: 1_700_090_000, gates: `all` }] } },
    ]);

    // No offer, so no bar: an empty track over a spent account is what this rail exists not to draw.
    expect(barWidths(el)).toEqual([]);
    expect(el.textContent).toContain(`Unavailable`);
    expect(el.textContent).toContain(`Claude Code`);
    // The absence is dated, not merely stated: waiting is the only thing left to do about it.
    expect(el.querySelector(`[aria-label="Plan headroom"]`)?.textContent).toMatch(/Nothing has room right now/);
});

// An account past the red line but not yet exhausted keeps its row; steering is by tone (danger red) rather than
// by dropping it, which read as the account having gone missing.
it(`draws an account that is nearly spent in the danger tone rather than dropping it`, () => {
    const el = mount([
        { id: `a`, label: `first@example.com`, usage: { measuredAt: MEASURED_AT, windows: [{ kind: `seven_day`, utilization: 96, resetsAt: 1_700_090_000, gates: `all` }] } },
    ]);

    expect(barWidths(el)).toEqual([`96%`]);
    expect(el.textContent).not.toContain(`Unavailable`);
    expect(el.querySelector(`[aria-hidden="true"] .tabular-nums`)?.className).toContain(`text-danger`);
});

it(`spells out for a screen reader what the bar says by its width`, () => {
    const el = mount([
        { id: `a`, label: `first@example.com`, usage: { measuredAt: MEASURED_AT, windows: [{ kind: `seven_day`, utilization: 41, resetsAt: 1_700_090_000, gates: `all` }] } },
    ]);

    // Every part the column shortens or drops is spoken here or nowhere; a bar is decoration to a screen reader.
    expect(spoken(el)).toContain(`Weekly · all models 41% (resets ${formatReset(1_700_090_000)})`);
    // Spoken once: the drawn row is hidden from the tree, or a reader would hear both the truncated and full line.
    expect(el.querySelector(`[aria-hidden="true"] .tabular-nums`)?.textContent?.trim()).toBe(`41%`);
});

// Both of an account's allowances are drawn, each beside its own window's length: one bar at the tighter of the
// two hid whether 87% meant an hour's wait or a week's rationing.
it(`draws both the session and the week, each named by its own window`, () => {
    const el = mount([
        {
            id: `a`,
            label: `first@example.com`,
            usage: {
                measuredAt: MEASURED_AT,
                windows: [
                    { kind: `five_hour`, utilization: 12, resetsAt: 1_700_020_000, gates: `all` },
                    { kind: `seven_day`, utilization: 87, resetsAt: 1_700_090_000, gates: `all` },
                ],
            },
        },
    ]);

    // A bar each, at its own pool's reading, rather than one bar at the worse of the two.
    expect(barWidths(el)).toEqual([`12%`, `87%`]);
    // Each stands beside its window's length, short enough to need no legend; the 5-hour session comes first.
    expect(lanes(el)).toEqual([`5h`, `wk`]);
    expect([...el.querySelectorAll(`[aria-hidden="true"] .tabular-nums`)].map((node) => node.textContent?.trim())).toEqual([`12%`, `87%`]);
});
