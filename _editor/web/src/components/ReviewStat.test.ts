// @vitest-environment jsdom
//
// The badge's job is to always state a number and to be honest about which reading it is, so what is asserted
// here is WHICH reading it prints in each state, not its markup, beyond the one class that marks a count as
// still provisional. Mounted with plain Vue, as markdownFigures.test does, rather than adding @vue/test-utils.
import { describe, expect, it } from "vitest";
import { createApp, h, nextTick } from "vue";

import ReviewStat from "./ReviewStat.vue";
import { useLayout } from "../composables/useLayout";
import type { LineStat } from "../composables/workspace/codeStat";

const { showComments, toggleShowComments } = useLayout();

interface Props {
    code?: LineStat;
    counting?: boolean;
    additions?: number;
    deletions?: number;
    of?: number;
}

const render = (props: Props): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    const app = createApp({ render: () => h(ReviewStat, props) });
    // Both are global in the real app (installUi). The glyph is stubbed away because nothing here asserts on it;
    // the tooltip keeps its text, since which reading the hover offers is half of what this file is about.
    app.component(`Icon`, { render: () => null });
    app.directive(`tooltip`, {
        mounted: (el: HTMLElement, binding: { value?: string }) => {
            if (binding.value !== undefined) {
                el.dataset[`tip`] = binding.value;
            }
        },
    });
    app.mount(host);
    return host;
};

const withComments = async (on: boolean): Promise<void> => {
    if (showComments.value !== on) {
        toggleShowComments();
    }
    await nextTick();
};

describe(`<ReviewStat>`, () => {
    it(`prints the code-only counts while the comments are hidden, and says what git makes it on hover`, async () => {
        await withComments(false);
        const host = render({ code: { additions: 3, deletions: 0 }, additions: 34, deletions: 8 });

        expect(host.textContent).toContain(`+3`);
        expect(host.textContent).not.toContain(`34`);
        expect(host.querySelector<HTMLElement>(`[data-tip]`)?.dataset[`tip`]).toContain(`+34`);
        expect(host.querySelector<HTMLElement>(`[data-tip]`)?.dataset[`tip`]).toContain(`−8`);
    });

    it(`hands the numbers back to git when the reader asks for the comments`, async () => {
        await withComments(true);
        const host = render({ code: { additions: 3, deletions: 0 }, additions: 34, deletions: 8 });

        expect(host.textContent).toContain(`+34`);
        expect(host.textContent).toContain(`−8`);
        // Nothing differs from what is on screen, so there is nothing for a hover to add.
        expect(host.querySelector(`[data-tip]`)).toBeNull();
    });

    it(`says a change is comments rather than showing it as nothing at all`, async () => {
        await withComments(false);
        const host = render({ code: { additions: 0, deletions: 0 }, additions: 26, deletions: 4 });

        // +0 −0 is how the badge says "a rename", and it reads as though the file were untouched.
        expect(host.textContent).toMatch(/comments|\+0|−0/);
        const tip = host.querySelector<HTMLElement>(`[data-tip]`)?.dataset[`tip`] ?? ``;
        expect(tip).toContain(`+26`);
        expect(tip).toContain(`−4`);
    });

    it(`shows git's own for a file it could not strip, with nothing extra claimed on hover`, async () => {
        await withComments(false);
        const host = render({ code: undefined, additions: 12, deletions: 2 });

        expect(host.textContent).toContain(`+12`);
        expect(host.textContent).toContain(`−2`);
        expect(host.querySelector(`[data-tip]`)).toBeNull();
    });

    /* THE CASE THIS COMPONENT WAS GETTING WRONG. A row whose file had not been read printed nothing but a pending
     * mark, and on the workspace Changes panel, where the reading is a background read that arrives in its own
     * time, that was every row of the list at once: a review with no numbers on it. It prints git's, marked as
     * standing in for a reading still being worked out. */
    it(`stands git's numbers in, at half weight, while the reading is still being worked out`, async () => {
        await withComments(false);
        const host = render({ counting: true, additions: 54, deletions: 0 });

        expect(host.textContent).toContain(`+54`);
        expect(host.textContent).not.toContain(`…`);
        expect(host.querySelector(`.opacity-50`)).not.toBeNull();
        expect(host.querySelector<HTMLElement>(`[data-tip]`)?.dataset[`tip`]).toContain(`+54`);
        expect(host.querySelector<HTMLElement>(`[data-tip]`)?.dataset[`tip`]).toMatch(/counting comments|still working/i);
    });

    it(`has nothing to wait for when the comments are shown: git's counts are the reading, at full weight`, async () => {
        await withComments(true);
        const host = render({ counting: true, additions: 54, deletions: 0 });

        expect(host.textContent).toContain(`+54`);
        expect(host.querySelector(`.opacity-50`)).toBeNull();
        expect(host.querySelector(`[data-tip]`)).toBeNull();
    });
});

/* The rail: the same badge asked how much new code this file is against the rest of the list. What matters is
 * that it agrees with the numbers printed beside it — a bar scaled off a reading the badge is not showing would
 * be two answers to one question, a few pixels apart — and that it draws nothing where there is nothing to rank. */
const rail = (host: HTMLElement): HTMLElement | null => host.querySelector<HTMLElement>(`span[aria-hidden="true"]`);
// The bar's own length as a share of its track.
const fill = (host: HTMLElement): string | undefined => (rail(host)?.firstElementChild as HTMLElement | undefined)?.style.width;

describe(`<ReviewStat> rail`, () => {
    it(`draws nothing at all unless the caller says what to scale against`, async () => {
        await withComments(false);
        expect(rail(render({ code: { additions: 12, deletions: 3 }, additions: 12, deletions: 3 }))).toBeNull();
    });

    it(`fills the track for the file that added the most in the list`, async () => {
        await withComments(false);
        expect(fill(render({ code: { additions: 50, deletions: 10 }, additions: 60, deletions: 12, of: 50 }))).toBe(`100%`);
    });

    /* THE INVARIANT WORTH PINNING. This file's git additions (34) are eleven times its code additions (3), and
     * the badge is printing the code ones. Scaled against a list whose biggest addition is 34, a bar drawn off
     * git's number would be full; off the number on screen it is a third of the track. */
    it(`scales to the reading the badge is showing, not to git's`, async () => {
        await withComments(false);
        expect(fill(render({ code: { additions: 3, deletions: 0 }, additions: 34, deletions: 8, of: 34 }))).not.toBe(`100%`);
    });

    it(`follows the reader back to git's numbers when the comments come on`, async () => {
        await withComments(true);
        expect(fill(render({ code: { additions: 3, deletions: 0 }, additions: 34, deletions: 8, of: 34 }))).toBe(`100%`);
    });

    /* A DELETION IS NOT THE SMALLEST THING IN THE LIST, it is a row with no new code in it, and an empty track
     * would say the first of those. This is the case that made the measure additions rather than churn: with the
     * rail scaled by total change, one removed bundle sets the top of the scale and buries everything else. */
    it(`stays off a row that added nothing, however much it removed`, async () => {
        await withComments(false);
        expect(rail(render({ code: { additions: 0, deletions: 1353 }, additions: 0, deletions: 1353, of: 131 }))).toBeNull();
    });

    it(`stays away from a row whose size is unknown rather than drawing a zero`, async () => {
        await withComments(false);
        expect(rail(render({ counting: false, of: 50 }))).toBeNull();
    });

    it(`marks a rail standing on a provisional count the same way the numbers are marked`, async () => {
        await withComments(false);
        const host = render({ counting: true, additions: 54, deletions: 0, of: 54 });
        expect(rail(host)?.className).toContain(`opacity-50`);
    });
});
