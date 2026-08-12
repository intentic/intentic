// @vitest-environment jsdom
//
// THE PRICE DISCLOSURE, which is the part of this change that is not a convenience. A premium install spends real
// money on a click, so what is pinned here is that the figure, the balance and the after-figure are all actually
// PRINTED — and, just as deliberately, that a short balance is never stated as a refusal: the donation is
// idempotent per month, so a reader whose balance looks too small may still be installing for free, and only the
// platform knows which. See the component's own block comment.
import type { MembershipState } from "@intentic-app/api-contract";
import { describe, expect, it, vi } from "vitest";
import { createApp, h, type VNode } from "vue";

vi.hoisted(() => {
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof matchMedia;
});

const shared = vi.hoisted(() => ({ current: undefined as MembershipState | undefined }));

vi.mock(`../../composables/membership/useMembership`, async () => {
    const { computed } = await import(`vue`);
    const { creditMeter } = await import(`../../composables/membership/creditMeter`);
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

import PremiumCost from "./PremiumCost.vue";

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

const render = (state: MembershipState | undefined, props: { update?: boolean } = {}): HTMLElement => {
    shared.current = state;
    const host = document.createElement(`div`);
    document.body.append(host);
    const app = createApp({ render: () => h(PremiumCost, props) });
    app.component(`Icon`, { render: () => null });
    app.component(`RouterLink`, {
        props: [`to`],
        render: (ctx: { $slots: { default?: () => VNode[] } }) => h(`a`, {}, ctx.$slots.default?.()),
    });
    app.mount(host);
    return host;
};

describe(`PremiumCost`, () => {
    it(`states the price, what is left, and what would be left`, () => {
        const text = render(membership()).textContent ?? ``;
        expect(text).toContain(`200 credits`);
        expect(text).toContain(`800`); // left today
        expect(text).toContain(`600`); // after this
    });

    it(`says the charge happens once a month and using it never costs again`, () => {
        // The two facts that stop an install reading as a subscription — and the reason it is worth saying yes to.
        const text = render(membership()).textContent ?? ``;
        expect(text).toContain(`Once a month per extension`);
        expect(text).toContain(`a reinstall this month is free`);
    });

    it(`calls an update an update, since it is the same money with a different verb`, () => {
        const text = render(membership(), { update: true }).textContent ?? ``;
        expect(text).toContain(`Updating supports the creator`);
        expect(text).toContain(`another update this month is free`);
    });

    /* THE ONE THAT MATTERS MOST. A balance below the price is a possibility, not a verdict: the reader may have
     * already supported this extension this month, in which case the install is free and the balance is
     * irrelevant. So the wording has to hedge, and it has to promise the refund. */
    it(`treats a short balance as a maybe and never as a failure`, () => {
        const text =
            render(membership({ credits: { allowance: 1_000, used: 900, remaining: 100, resetsAt: `2026-08-13T00:00:00.000Z` } })).textContent ?? ``;
        expect(text).toContain(`might not cover this`);
        expect(text).toContain(`nothing is charged`);
        expect(text).not.toContain(`will fail`);
    });

    it(`offers a non-member the door rather than a refusal`, () => {
        const host = render(membership({ member: false, credits: undefined }));
        const text = host.textContent ?? ``;
        expect(text).toContain(`This one is premium`);
        expect(text).toContain(`200 credits`);
        expect(text).toContain(`See what a membership costs`);
        expect(host.querySelector(`a`)).not.toBeNull();
    });

    it(`says nothing on a platform with no pool, where no premium install can happen at all`, () => {
        expect(render(membership({ enabled: false, member: false, credits: undefined })).textContent).toBe(``);
    });

    it(`says nothing where the platform gives its extensions away`, () => {
        // No charge means nothing to warn anybody about — and no zero-price block pretending otherwise.
        expect(render(membership({ donationCredits: 0 })).textContent).toBe(``);
    });
});
