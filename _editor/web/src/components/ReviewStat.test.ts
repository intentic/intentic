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
