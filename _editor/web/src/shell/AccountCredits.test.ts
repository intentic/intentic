// @vitest-environment jsdom
//
// THE ROW THAT ANSWERS "WHERE ARE MY CREDITS". What matters about it is not its markup but WHICH SENTENCE it
// prints in each state: an untouched allowance, a spent one, and the two cases where it must not appear at all
//, because each of those is a decision about what the reader is told, and each was got wrong by the surface
// this replaces (which said nothing anywhere). Mounted with plain Vue, as ReviewStat.test does.
import type { MembershipState } from "@intentic-app/api-contract";
import { describe, expect, it, vi } from "vitest";
import { createApp, h, type VNode } from "vue";

// The @intentic/ui barrel reaches a component that tracks media queries at import time, and jsdom has no
// matchMedia: vitest.setup.ts stands one up for the package, before any of this loads.

// Hoisted so the mock factory below never reads it in its temporal dead zone (see vitest.config.ts).
const shared = vi.hoisted(() => ({ current: undefined as MembershipState | undefined }));

// The component reads the app's ONE membership entry, which is a live query; what this file exercises is the
// rendering, so the query is replaced by the same shape over a value each test sets.
vi.mock(`../composables/membership/useMembership`, async () => {
    const { computed } = await import(`vue`);
    const { creditMeter } = await import(`../composables/membership/creditMeter`);
    return {
        useMembership: () => ({
            state: computed(() => shared.current),
            offered: computed(() => shared.current?.enabled === true),
            member: computed(() => shared.current?.member === true),
            meter: computed(() => creditMeter(shared.current)),
            donationCredits: computed(() => shared.current?.donationCredits ?? 0),
            dailyCredits: computed(() => shared.current?.dailyCredits ?? 0),
            isLoading: computed(() => false),
            error: computed(() => null),
            spent: async (): Promise<void> => {},
            refetch: async (): Promise<void> => {},
        }),
    };
});

import AccountCredits from "./AccountCredits.vue";

const membership = (over: Partial<MembershipState> = {}): MembershipState =>
    ({
        enabled: true,
        member: true,
        priceUsd: 20,
        creatorShare: 0.9,
        dailyCredits: 1_000,
        donationCredits: 200,
        credits: { allowance: 1_000, used: 200, remaining: 800, resetsAt: `2026-08-13T00:00:00.000Z` },
        ...over,
    }) as MembershipState;

const render = (state: MembershipState | undefined): HTMLElement => {
    shared.current = state;
    const host = document.createElement(`div`);
    document.body.append(host);
    const app = createApp({ render: () => h(AccountCredits) });
    // Both are global in the real app. The glyph is stubbed away: nothing here asserts on it, and RouterLink
    // becomes a plain anchor so the row's destination stays assertable.
    app.component(`Icon`, { render: () => null });
    app.component(`RouterLink`, {
        props: [`to`],
        render: (ctx: { $slots: { default?: () => VNode[] } }) => h(`a`, {}, ctx.$slots.default?.()),
    });
    app.mount(host);
    return host;
};

describe(`AccountCredits`, () => {
    it(`says nothing to somebody with no allowance, rather than drawing an empty one`, () => {
        // A zeroed meter and "no meter" mean opposite things, and only one of them is this reader's situation.
        expect(render(membership({ member: false, credits: undefined })).textContent).toBe(``);
    });

    it(`says nothing on a platform that sells no membership`, () => {
        expect(render(membership({ enabled: false, member: false, credits: undefined })).textContent).toBe(``);
    });

    it(`leads with what is LEFT, which is the question it gets opened with`, () => {
        const text = render(membership()).textContent ?? ``;
        expect(text).toContain(`800`);
        expect(text).toContain(`of 1,000 credits left today`);
    });

    it(`draws the bar as the remainder, not as the spend`, () => {
        const bar = render(membership()).querySelector<HTMLElement>(`[style*="width"]`);
        expect(bar?.style.width).toBe(`80%`);
    });

    it(`tells a spent day that the whole allowance comes back, instead of reporting a nought`, () => {
        const text = render(
            membership({ credits: { allowance: 1_000, used: 1_000, remaining: 0, resetsAt: `2026-08-13T00:00:00.000Z` } }),
        ).textContent;
        expect(text).toContain(`Spent for today`);
        expect(text).toContain(`full allowance is back at`);
    });

    // "Low" is defined as "another install is out of reach", so the row says that rather than a percentage.
    it(`names what a low balance actually costs the reader`, () => {
        const text = render(
            membership({ credits: { allowance: 1_000, used: 900, remaining: 100, resetsAt: `2026-08-13T00:00:00.000Z` } }),
        ).textContent;
        expect(text).toContain(`Not enough for another premium install today`);
    });

    it(`offers the reset time on an ordinary day, because that is the only other thing to know`, () => {
        expect(render(membership()).textContent).toContain(`Resets at`);
    });
});
