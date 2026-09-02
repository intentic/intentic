// @vitest-environment jsdom
//
// The badge's job is to state a number and to be honest about which reading it is, so what is asserted here is
// WHICH reading it prints in each state, not its markup. Every number it is given is final — the daemon counts
// the code-only pair and ships it with the change — so there is no provisional state left to assert on. Mounted
// with plain Vue, as markdownFigures.test does, rather than adding @vue/test-utils.
import { describe, expect, it } from "vitest";
import { createApp, h, nextTick } from "vue";

import ReviewStat from "./ReviewStat.vue";
import { useLayout } from "../composables/useLayout";
import type { LineStat } from "@intentic/code-read";

const { showComments, toggleShowComments } = useLayout();

interface Props {
    code?: LineStat;
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

    /* A FILE THERE IS NO CODE-ONLY READING OF — bytes, one side too large, a language this build ships no
     * grammar for — arrives with no `code` at all, and git's numbers are then the reading rather than standing in
     * for one. At full weight and with no hover, because nothing about it is provisional: this is the answer. */
    it(`prints git's numbers whole for a file that cannot be read as code`, async () => {
        await withComments(false);
        const host = render({ additions: 54, deletions: 0 });

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
        expect(rail(render({ of: 50 }))).toBeNull();
    });
});
